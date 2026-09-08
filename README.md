# codex-openai-proxy

A minimal, zero-dependency Node.js proxy that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint backed by your Codex CLI's ChatGPT Plus OAuth
session (`~/.codex/auth.json`) — so OpenAI-compatible tools can use your
ChatGPT Plus subscription instead of a separate paid API key.

## Quick start

```bash
node bin/cli.js --port 8080
```

This prints a random API key on startup (or set your own via `--api-key` /
`PROXY_API_KEY`) — you'll need it for every request except `/health`:

```
codex-openai-proxy listening on http://127.0.0.1:8080
API key (send as "Authorization: Bearer <key>"): 3c1b8f2e-...
```

Then point any OpenAI-compatible client at `http://localhost:8080`:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key from startup log>" \
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
| `--host` / `HOST` | `127.0.0.1` | Interface to bind to — keep this on loopback unless you know you want it reachable from elsewhere |
| `--auth-path` / `CODEX_AUTH_PATH` | `~/.codex/auth.json` | Path to Codex CLI's auth file |
| `--api-key` / `PROXY_API_KEY` | randomly generated at startup | Bearer token clients must send; required because this proxy rides your live ChatGPT session with no other access control |
| `--allow-remote-images` / `ALLOW_REMOTE_IMAGES=1` | off | Let callers pass reference images as http(s) URLs. Off by default: the proxy would otherwise fetch arbitrary URLs on a caller's behalf, from wherever it runs |
| `--max-body-mb` / `MAX_BODY_MB` | `32` | Request body cap. Reference images are inlined, so bodies get large — but bounded |

## Security notes

- The server binds to `127.0.0.1` by default. There's no CORS restriction, so
  binding it to a wider interface (or exposing it via a tunnel) means
  **anything that can reach the port — including a malicious webpage your
  browser visits, if bound beyond loopback — can spend your ChatGPT Plus
  quota** unless it also has the API key.
- All endpoints except `/health` require `Authorization: Bearer <api-key>`.
- Error responses never include raw upstream/internal error text; full detail
  is logged server-side (stdout/stderr) instead.

## Endpoints

- `GET /health` — status check
- `GET /agent.md` — agent guide (`text/markdown`; also `/llms.txt`, `/AGENTS.md`)
- `GET /v1/models` — model slugs available to your account
- `POST /v1/chat/completions` — OpenAI-compatible chat completions, streaming and non-streaming
- `GET /v1/images/sizes` — named frame presets (banner/ad/social) and supported formats
- `POST /v1/images/generations` — image generation; PNG, JPEG or WebP as `b64_json`
- `POST /v1/images/edits` — image generation guided by reference images (JSON base64 or multipart)

## Images

`size` accepts `1200x628` or a preset name (`leaderboard`, `og`, `story`, `mrec`, …;
`GET /v1/images/sizes` lists them all), `output_format` accepts `png` / `jpeg` / `webp`,
and `image` accepts one or more reference images as base64, a `data:` URL, or multipart
file parts.

```bash
curl http://localhost:8080/v1/images/edits \
  -H "Authorization: Bearer <key>" \
  -F "image=@logo.png" \
  -F "prompt=Put this logo on a mint-green promo banner" \
  -F "size=leaderboard" -F "output_format=webp"
```

The upstream image tool picks its own canvas and ignores a requested size, so the proxy
describes the target frame in the prompt and then crops the result to exact pixels
(`fit`: `cover` by default, or `contain` / `fill` / `none`). That local step uses Pillow
(`python3 -m pip install pillow`) if present, otherwise `sips` on macOS for PNG and JPEG.
With neither available the image still comes back — at the model's own size, with a
`warning` field explaining why.

## How it works

Requests are converted from OpenAI Chat Completions format into ChatGPT's
internal Responses API format and sent to
`https://chatgpt.com/backend-api/codex/responses` using your Codex CLI's
access token. The access token is refreshed automatically (via
`https://auth.openai.com/oauth/token`) when it's expired or close to expiry,
mirroring what the Codex CLI itself does, and the refreshed tokens are written
back to `auth.json`.

## Tests

```bash
npm test
```
