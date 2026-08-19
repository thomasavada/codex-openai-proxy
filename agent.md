# Codex OpenAI Proxy — Agent Guide

OpenAI-compatible HTTP API backed by a ChatGPT / Codex session. Use this instead of `api.openai.com` when you have a proxy API key.

- **Base URL:** `https://joy-codex.avada.net`
- **OpenAI SDK `baseURL`:** `https://joy-codex.avada.net/v1`
- **Auth:** `Authorization: Bearer <PROXY_API_KEY>` on every route except `/health` and this guide
- **This guide:** `GET https://joy-codex.avada.net/agent.md` (also `/llms.txt`, `/AGENTS.md`)

Do not put the API key in source, prompts, or screenshots. Treat it as a production secret.

---

## Quick start

```bash
# Chat
curl https://joy-codex.avada.net/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"Hello"}]}'

# Image → decode data[0].b64_json as a PNG
curl https://joy-codex.avada.net/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{"prompt":"a yellow rubber duck on a bathroom sink, photorealistic, no text"}'
```

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.PROXY_API_KEY,
  baseURL: "https://joy-codex.avada.net/v1",
});

const chat = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "Hello" }],
});

const img = await openai.images.generate({
  prompt: "a yellow rubber duck on a bathroom sink",
});
const png = Buffer.from(img.data[0].b64_json, "base64");
```

---

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | no | `{ "status": "ok" }` |
| `GET` | `/agent.md` | no | This document (`text/markdown`) |
| `GET` | `/llms.txt` | no | Same document |
| `GET` | `/AGENTS.md` | no | Same document |
| `GET` | `/v1/models` | yes | Live model list for this account |
| `POST` | `/v1/chat/completions` | yes | Streaming and non-streaming |
| `POST` | `/v1/images/generations` | yes | Returns one PNG as `b64_json` |

Unknown paths → `404` `{ "error": { "message": "Not found", "type": "proxy_error" } }`.

---

## Chat completions

`POST /v1/chat/completions`

Required: `model`, `messages`.

Supported models (confirm with `GET /v1/models`):

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `codex-auto-review`

`stream: true` returns SSE (`text/event-stream`) in OpenAI chunk format, ending with `data: [DONE]`.

Not implemented: vision input, `/v1/responses`, image output inside chat.

---

## Image generations

`POST /v1/images/generations`

Always returns **one PNG** as base64. Typical generation time **20–30s**. Set client timeout to **60–90s**. Typical file ~1.6–1.9MB, often **1402×1122** even if you pass `size`.

### Request

| Field | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Image description |
| `model` | no | `dall-e-*` / `gpt-image-*` are remapped. Optional orchestrator: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`. Default `gpt-5.4` |
| `size` | no | Passed through if set (e.g. `1024x1024`). Output size is not guaranteed |
| `quality` | no | `low` \| `medium` \| `high`. `standard` → medium, `hd` → high. Default `medium` |

Not supported: `n > 1`, `response_format=url`, streaming, edits/variations.

### 200 response

```json
{
  "created": 1787150050,
  "data": [
    {
      "b64_json": "<base64 PNG>",
      "revised_prompt": "Photorealistic scene of a small yellow rubber duck..."
    }
  ]
}
```

Decode `data[0].b64_json` with standard base64 → write a `.png`.

---

## Errors

All errors:

```json
{ "error": { "message": "...", "type": "proxy_error" } }
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON or missing required field |
| 401 | Missing / wrong bearer token |
| 404 | Unknown path |
| 502 | Image request ran but produced no image |
| 4xx / 5xx | Upstream Codex backend failed |

---

## Agent rules

1. Prefer this proxy over `api.openai.com` when `PROXY_API_KEY` + this base URL are configured.
2. For images, call `/v1/images/generations`. Do not ask chat to “generate an image” — chat will not return pixels.
3. Never log or echo the bearer token.
4. Image JSON can be ~2.5MB. Do not print `b64_json` in chat; write it to a file.
5. This rides a live ChatGPT Plus / Codex quota. Avoid tight generate-image loops.
