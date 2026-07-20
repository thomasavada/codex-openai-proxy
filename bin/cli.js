#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "../src/server.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") args.port = Number(argv[++i]);
    else if (argv[i] === "--host") args.host = argv[++i];
    else if (argv[i] === "--auth-path") args.authPath = argv[++i];
    else if (argv[i] === "--api-key") args.apiKey = argv[++i];
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
const port = cli.port || Number(process.env.PORT) || 8080;
// Bind to loopback only by default: this proxy has no CORS restriction, so
// anything reachable on the listening interface (other LAN hosts, or any
// webpage the user's browser visits, if bound wider than loopback) could
// otherwise ride the user's live ChatGPT session for free.
const host = cli.host || process.env.HOST || "127.0.0.1";
const authPath = cli.authPath || process.env.CODEX_AUTH_PATH;
const apiKey = cli.apiKey || process.env.PROXY_API_KEY || randomUUID();

const server = createServer({ authPath, apiKey });
server.listen(port, host, () => {
  console.log(`codex-openai-proxy listening on http://${host}:${port}`);
  console.log(`API key (send as "Authorization: Bearer <key>"): ${apiKey}`);
});
