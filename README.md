# codex-openai-proxy

A minimal, zero-dependency Node.js proxy that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint backed by your Codex CLI's ChatGPT Plus OAuth
session (`~/.codex/auth.json`) — so OpenAI-compatible tools can use your
ChatGPT Plus subscription instead of a separate paid API key.

## Quick start

```bash
node bin/cli.js --port 8080
```

Then point any OpenAI-compatible client at `http://localhost:8080`:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Use `GET /v1/models` to see which model slugs are currently valid for your
account (read from `~/.codex/models_cache.json`, populated the last time you
ran the Codex CLI).

## Configuration

| Flag / env var | Default | Description |
| --- | --- | --- |
| `--port` / `PORT` | `8080` | Port to listen on |
| `--auth-path` / `CODEX_AUTH_PATH` | `~/.codex/auth.json` | Path to Codex CLI's auth file |

## Endpoints

- `GET /health` — status check
- `GET /v1/models` — model slugs available to your account
- `POST /v1/chat/completions` — OpenAI-compatible chat completions, streaming and non-streaming

## How it works

Requests are converted from OpenAI Chat Completions format into ChatGPT's
internal Responses API format and sent to
`https://chatgpt.com/backend-api/codex/responses` using your Codex CLI's
access token. The access token is refreshed automatically (via
`https://auth.openai.com/oauth/token`) when it's expired or close to expiry,
mirroring what the Codex CLI itself does, and the refreshed tokens are written
back to `auth.json`.

## Not yet implemented

Image generation is possible through the same backend/auth (verified via the
`image_generation` tool on the Responses API), but there's no
`/v1/images/generations` endpoint yet — out of scope for this first version.

## Tests

```bash
npm test
```
