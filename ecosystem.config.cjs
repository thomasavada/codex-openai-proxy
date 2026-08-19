const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const envFile = path.join(os.homedir(), ".config", "codex-openai-proxy.env");
const env = Object.fromEntries(
  fs
    .readFileSync(envFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)];
    }),
);

module.exports = {
  apps: [
    {
      name: "codex-openai-proxy",
      cwd: __dirname,
      script: "bin/cli.js",
      interpreter: "/Users/thomas/.nvm/versions/node/v22.21.1/bin/node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: "5s",
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,
      env,
    },
  ],
};
