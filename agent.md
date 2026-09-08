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

# Image → decode data[0].b64_json
curl https://joy-codex.avada.net/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{"prompt":"a yellow rubber duck on a bathroom sink, photorealistic, no text"}'

# Banner at an exact frame, as WebP
curl https://joy-codex.avada.net/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{"prompt":"loyalty rewards promo, teal and cream, gift icon left, headline space right",
       "size":"leaderboard","output_format":"webp"}'

# Edit with a reference image (multipart, same shape as the OpenAI SDK)
curl https://joy-codex.avada.net/v1/images/edits \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -F "image=@logo.png" \
  -F "prompt=Put this logo on a mint-green promo banner" \
  -F "size=og" -F "output_format=webp"
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
| `GET` | `/v1/images/sizes` | yes | Named frame presets + supported formats |
| `POST` | `/v1/images/generations` | yes | Text → image, optional reference images |
| `POST` | `/v1/images/edits` | yes | Reference image(s) → image; JSON or multipart |

Unknown paths → `404` `{ "error": { "message": "Not found", "type": "proxy_error" } }`.

---

## Chat completions

`POST /v1/chat/completions`

Required: `model`, `messages`.

Supported models (confirm with `GET /v1/models`):

- `gpt-6-astra`
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- `gpt-5.5`
- `gpt-5.4-mini`
- `codex-auto-review`

`stream: true` returns SSE (`text/event-stream`) in OpenAI chunk format, ending with `data: [DONE]`.

Not implemented: vision input, `/v1/responses`, image output inside chat.

---

## Image generations

`POST /v1/images/generations` — text to image, optionally guided by reference images.
`POST /v1/images/edits` — the same pipeline with `image` required. Accepts **multipart/form-data**
(what `openai.images.edit()` sends) or plain JSON with base64.

Typical generation time **20–30s**. Set client timeout to **60–90s**.

### Request

| Field | Required | Notes |
| --- | --- | --- |
| `prompt` | yes | Image description |
| `image` | edits only | Reference image(s). Base64, a `data:image/...;base64,` URL, or a multipart file part. Repeat the field (or send an array) for up to 8. Turns the call into an edit |
| `size` | no | `WIDTHxHEIGHT` (e.g. `1200x628`) or a preset name. Output is cropped to **exactly** this. Omit or `auto` to let the model choose |
| `output_format` | no | `png` (default), `jpeg`, `webp` |
| `fit` | no | How to reach `size`: `cover` (default, centre-crop), `contain` (pad with `background`), `fill` (stretch), `none` (skip the local resize) |
| `background` | no | `transparent` (default), `opaque`, or `#rrggbb`. Used for `contain` padding and JPEG flattening |
| `quality` | no | `low` \| `medium` \| `high`. `standard` → medium, `hd` → high. Default `medium` |
| `model` | no | `dall-e-*` / `gpt-image-*` are remapped to a chat orchestrator. Pass `gpt-5.5` etc. to pick one |

Not supported: `n > 1`, `response_format=url`, streaming, `mask` (inpainting), variations.
Reference images by http(s) URL are refused unless the proxy runs with `--allow-remote-images`.

### Sizes

`GET /v1/images/sizes` returns the live list. Presets include:

| Group | Names |
| --- | --- |
| Social | `square` / `instagram` (1080x1080), `instagram-portrait`, `story` / `reel` / `tiktok` (1080x1920), `og` / `facebook` (1200x630), `linkedin`, `twitter` / `x`, `pinterest`, `youtube-thumbnail` |
| Display ads | `leaderboard` (728x90), `large-leaderboard`, `billboard` (970x250), `medium-rectangle` / `mrec` (300x250), `large-rectangle`, `half-page`, `wide-skyscraper`, `mobile-leaderboard`, `mobile-banner` |
| Web / email | `hero` (1920x1080), `hero-wide` (1920x600), `email-header` (600x200), `app-icon` (1024x1024) |

**How sizing actually works.** The upstream model picks its own canvas and ignores a
requested size, and it will not go past roughly 3:1 in either direction. So the proxy
does two things: it describes the target frame in the prompt, then crops/resizes the
result to the exact pixels. For extreme frames (a 728x90 leaderboard is 8:1) that crop
throws away a lot of height — write prompts that keep the subject and any text centred
and give the composition room, or use `fit: "contain"` with a `background` colour.

### 200 response

```json
{
  "created": 1787150050,
  "output_format": "webp",
  "size": "728x90",
  "quality": "medium",
  "data": [
    {
      "b64_json": "<base64 image in output_format>",
      "revised_prompt": "A promotional web banner for a loyalty rewards app..."
    }
  ]
}
```

Decode `data[0].b64_json` and write it with the extension from `output_format`.

A `warning` field means the image is real but the host could not apply the requested
frame locally — check `size` against the actual bytes before using it.

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
| 413 | Request body over the size limit (32MB default) |
| 502 | Image request ran but produced no image |
| 4xx / 5xx | Upstream Codex backend failed |

---

## Agent rules

1. Prefer this proxy over `api.openai.com` when `PROXY_API_KEY` + this base URL are configured.
2. For images, call `/v1/images/generations`. Do not ask chat to “generate an image” — chat will not return pixels.
3. Never log or echo the bearer token.
4. Image JSON can be ~2.5MB. Do not print `b64_json` in chat; write it to a file.
5. For a banner or ad slot, pass `size` (a preset name is fine) rather than resizing afterwards — the proxy already returns exact pixels.
6. To keep a logo, product or style consistent across images, send it as `image` rather than describing it.
7. This rides a live ChatGPT Plus / Codex quota. Avoid tight generate-image loops.
