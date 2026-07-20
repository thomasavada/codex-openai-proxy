import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_MARGIN_SECONDS = 60;

export function resolveAuthPath(explicitPath) {
  const raw = explicitPath || process.env.CODEX_AUTH_PATH || "~/.codex/auth.json";
  return raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
}

function decodeJwtExp(token) {
  const payload = token.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json).exp;
}

async function loadAuth(authPath) {
  const raw = await readFile(authPath, "utf8");
  return JSON.parse(raw);
}

async function saveAuth(authPath, auth) {
  await writeFile(authPath, JSON.stringify(auth, null, 2));
}

async function refreshTokens(authPath, auth) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refresh_token,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    throw new Error(`Codex token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  auth.tokens.access_token = data.access_token;
  if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token;
  auth.last_refresh = new Date().toISOString();
  await saveAuth(authPath, auth);
  return auth;
}

export async function getAccessToken(authPath, { forceRefresh = false } = {}) {
  let auth = await loadAuth(authPath);
  const exp = decodeJwtExp(auth.tokens.access_token);
  const now = Math.floor(Date.now() / 1000);

  if (forceRefresh || exp - now <= REFRESH_MARGIN_SECONDS) {
    auth = await refreshTokens(authPath, auth);
  }

  return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id };
}
