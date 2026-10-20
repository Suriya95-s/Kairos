# Kairos v3.0 — Deployment Guide

## Docker Compose (single-agent, local vLLM)

```yaml
# docker-compose.yml
services:
  agent:
    image: node:22-slim
    working_dir: /app
    volumes:
      - .:/app
      - ./workspace:/workspace
    environment:
      - AGENT_MODEL=qwen3-coder-30b
      - AGENT_BASE_URL=http://vllm:8000/v1
      - AGENT_NO_THINKING=1
    command: node src/cli.js run "your task here" --workspace /workspace
    depends_on: [vllm]

  vllm:
    image: vllm/vllm-openai:latest
    ports: ["8000:8000"]
    volumes:
      - ~/.cache/huggingface:/root/.cache/huggingface
    command: --model Qwen/Qwen3-Coder-30B-A3B --gpu-memory-utilization 0.9
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_MODEL` | `gpt-oss-120b` | Model ID served by vLLM |
| `AGENT_BASE_URL` | `http://localhost:8000/v1` | vLLM/OpenAI-compatible endpoint |
| `AGENT_API_KEY` | `` | API key (leave empty for local vLLM) |
| `AGENT_MAX_STEPS` | `0` (unlimited) | Hard step cap |
| `AGENT_MEMORY_WINDOW` | `20` | Working memory window size |
| `AGENT_NO_THINKING` | auto | Set `1` for Qwen3 / thinking models |
| `AGENT_HITL_REQUIRED` | `0` | Set `1` to enable Human-in-the-Loop |
| `AGENT_USE_PALACE` | `0` | Set `1` to enable Memory Palace (SQLite) |
| `AGENT_MCP_ENABLED` | `0` | Set `1` to load MCP servers |
| `KAIROS_OTEL` | `0` | Set `1` to emit OTel spans |
| `KAIROS_TELEMETRY` | `0` | Set `1` for opt-in telemetry |
| `KAIROS_LOG_JSON` | `0` | Set `1` for structured JSON logs |

## Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kairos-agent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kairos-agent
  template:
    metadata:
      labels:
        app: kairos-agent
    spec:
      containers:
        - name: agent
          image: your-registry/kairos-agent:v3.0
          env:
            - name: AGENT_MODEL
              value: "claude-sonnet-4-6"
            - name: AGENT_API_KEY
              valueFrom:
                secretKeyRef:
                  name: kairos-secrets
                  key: anthropic-api-key
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: workspace
          persistentVolumeClaim:
            claimName: kairos-workspace-pvc
```

## HITL Web UI

Start the live-view server on port 5180:

```bash
node apps/web-ui/server.js /path/to/workspace
```

Then open `http://localhost:5180` to approve/deny actions in real time.

## Feature flags summary

All advanced features default **OFF** in RC. Enable one at a time when tested:

```bash
AGENT_HITL_REQUIRED=1   # Human approval gate
AGENT_USE_PALACE=1       # Memory Palace (needs SQLite)
AGENT_MCP_ENABLED=1      # MCP server connections
KAIROS_OTEL=1            # OpenTelemetry spans
KAIROS_TELEMETRY=1       # Event telemetry (local only unless KAIROS_TELEMETRY_ENDPOINT set)
AGENT_MULTI_AGENT=1      # Multi-agent orchestration (Phase 3)
```
