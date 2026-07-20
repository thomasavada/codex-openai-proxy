#!/usr/bin/env node
import { createServer } from "../src/server.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" || argv[i] === "-p") args.port = Number(argv[++i]);
    else if (argv[i] === "--auth-path") args.authPath = argv[++i];
  }
  return args;
}

const cli = parseArgs(process.argv.slice(2));
const port = cli.port || Number(process.env.PORT) || 8080;
const authPath = cli.authPath || process.env.CODEX_AUTH_PATH;

const server = createServer({ authPath });
server.listen(port, () => {
  console.log(`codex-openai-proxy listening on http://localhost:${port}`);
});
