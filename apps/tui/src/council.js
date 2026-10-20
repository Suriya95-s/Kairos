// apps/tui/src/council.js
// LLM Council — Karpathy-style 3-stage deliberation:
//   1) every member answers the topic individually (parallel)
//   2) each member ranks the others' ANONYMIZED answers
//   3) a Chairman model synthesizes the single best answer
//
// The network is injected via `call(model, messages, opts)`, so the orchestration
// is fully unit-testable offline. `makeOpenRouterCall` is the default adapter.

// Curated OpenRouter free models. NOTE: `:free` IDs drift and are rate-limited —
// edit the lineup in the UI. `on` is the default council membership.
export const DEFAULT_COUNCIL_MODELS = [
  { id: 'meta-llama/llama-3.3-70b-instruct:free',        label: 'Llama 3.3 70B',     on: true  },
  { id: 'deepseek/deepseek-chat:free',                   label: 'DeepSeek Chat',     on: true  },
  { id: 'google/gemini-2.0-flash-exp:free',              label: 'Gemini 2.0 Flash',  on: true  },
  { id: 'qwen/qwen-2.5-72b-instruct:free',               label: 'Qwen2.5 72B',       on: false },
  { id: 'mistralai/mistral-small-3.1-24b-instruct:free', label: 'Mistral Small 3.1', on: false },
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct:free',   label: 'Nemotron 70B',      on: false },
];

function defaultShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Anonymize a set of answers for peer ranking: shuffle and relabel to
 * "Response #N" so no member can see who wrote what (or favor itself).
 * @param {{id:string,label:string,answer:string}[]} answers
 * @param {(a:any[])=>any[]} [shuffle]
 * @returns {{ labels: {tag:string,id:string,text:string}[], block: string }}
 */
export function anonymize(answers, shuffle = defaultShuffle) {
  const ordered = shuffle(answers.slice());
  const labels = ordered.map((a, i) => ({ tag: `Response #${i + 1}`, id: a.id, text: a.answer }));
  const block = labels.map(l => `=== ${l.tag} ===\n${l.text}`).join('\n\n');
  return { labels, block };
}

export function buildRankPrompt(topic, block) {
  return [
    { role: 'system', content: 'You are a careful, impartial judge. You do not know who wrote each response.' },
    { role: 'user', content:
`Topic:\n${topic}\n\nBelow are anonymized responses from several assistants. Rank them from best to worst with a one-line reason for each. Do not try to guess the authors.\n\n${block}\n\nReply exactly as:\n1. <Response #> — <reason>\n2. <Response #> — <reason>\n…` },
  ];
}

export function buildChairPrompt(topic, answers, rankings) {
  const ans = answers.map(a => `### ${a.label}\n${a.answer}`).join('\n\n');
  const rk  = rankings.map(r => `### ${r.label} ranked the responses:\n${r.rankText}`).join('\n\n');
  return [
    { role: 'system', content: 'You are the Chairman of an LLM council. Produce the single best final answer for the user.' },
    { role: 'user', content:
`Topic:\n${topic}\n\n## Council answers\n${ans}\n\n## Council rankings\n${rk}\n\nWrite the final, best answer. Be decisive, resolve disagreements, and keep only what is correct and useful. Do NOT mention "the council", the responses, or the rankings — just answer.` },
  ];
}

/**
 * Run the 3-stage council. Mutates and returns a snapshot-friendly state object;
 * `onProgress` receives a fresh copy after every model so a UI can repaint live.
 * Never throws for an individual model failure — that member is marked `failed`
 * and excluded from later stages.
 * @param {{ topic:string, members:{id:string,label?:string}[], chairman:string,
 *           call:Function, onProgress?:Function, shuffle?:Function, signal?:AbortSignal }} opts
 */
export async function runCouncil({ topic, members, chairman, call, onProgress = () => {}, shuffle, signal } = {}) {
  if (!topic || !String(topic).trim()) throw new Error('A topic is required.');
  if (!members?.length) throw new Error('Pick at least one council model.');
  if (typeof call !== 'function') throw new Error('A `call` function is required.');
  const aborted = () => !!signal?.aborted;

  const run = {
    topic: String(topic).trim(),
    chairman: chairman || members[0].id,
    stage: 1, status: 'stage1', final: '', error: '',
    members: members.map(m => ({ id: m.id, label: m.label || m.id, status: 'pending', answer: '', error: '', rankText: '' })),
  };
  const emit = () => onProgress({ ...run, members: run.members.map(x => ({ ...x })) });
  emit();

  // ── Stage 1: each member answers the topic ──────────────────────────────────
  await Promise.allSettled(run.members.map(async (m) => {
    m.status = 'running'; emit();
    try {
      if (aborted()) throw new Error('cancelled');
      const out = String(await call(m.id, [{ role: 'user', content: run.topic }], { temperature: 0.7 }) || '').trim();
      m.answer = out;
      m.status = out ? 'done' : 'failed';
      if (!out) m.error = 'empty response';
    } catch (err) {
      m.status = 'failed';
      m.error = err?.message || String(err);
    }
    emit();
  }));

  const survivors = () => run.members.filter(m => m.status === 'done');
  if (survivors().length < 1) {
    run.status = 'error';
    run.error = 'No council member produced an answer (all rate-limited or unreachable?).';
    emit();
    return run;
  }

  // ── Stage 2: each member ranks the anonymized answers ───────────────────────
  run.stage = 2; run.status = 'stage2'; emit();
  const { block } = anonymize(survivors().map(m => ({ id: m.id, label: m.label, answer: m.answer })), shuffle);
  await Promise.allSettled(survivors().map(async (m) => {
    try {
      if (aborted()) throw new Error('cancelled');
      m.rankText = String(await call(m.id, buildRankPrompt(run.topic, block), { temperature: 0.2 }) || '').trim();
    } catch (err) {
      m.rankText = `(ranking failed: ${err?.message || err})`;
    }
    emit();
  }));

  // ── Stage 3: Chairman synthesizes the final answer ──────────────────────────
  run.stage = 3; run.status = 'stage3'; emit();
  try {
    if (aborted()) throw new Error('cancelled');
    const answers  = survivors().map(m => ({ label: m.label, answer: m.answer }));
    const rankings = survivors().map(m => ({ label: m.label, rankText: m.rankText }));
    run.final = String(await call(run.chairman, buildChairPrompt(run.topic, answers, rankings), { temperature: 0.3, maxOutputTokens: 4096 }) || '').trim();
    run.status = run.final ? 'done' : 'error';
    if (!run.final) run.error = 'Chairman returned an empty synthesis.';
  } catch (err) {
    run.status = 'error';
    run.error = `Chairman synthesis failed: ${err?.message || err}`;
  }
  emit();
  return run;
}

/**
 * Default network adapter: an OpenRouter (OpenAI-compatible) `call`.
 * @param {() => string} getKey — returns the OpenRouter API key
 * @param {{ baseURL?: string }} [opts]
 * @returns {(model:string, messages:object[], opts?:object)=>Promise<string>}
 */
export function makeOpenRouterCall(getKey, { baseURL = 'https://openrouter.ai/api/v1' } = {}) {
  return async function call(model, messages, opts = {}) {
    const key = (getKey && getKey()) || '';
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        'HTTP-Referer': 'https://localhost',   // OpenRouter attribution (optional)
        'X-Title': 'Kairos LLM Council',
      },
      body: JSON.stringify({
        model, messages, stream: false,
        max_tokens: opts.maxOutputTokens || 2048,
        temperature: opts.temperature ?? 0.5,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 120000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    let out = choice?.message?.content || '';
    if (Array.isArray(out)) out = out.filter(b => b.type === 'text').map(b => b.text || '').join('');
    if (!out && choice?.message?.reasoning_content) out = choice.message.reasoning_content;
    return out || '';
  };
}
