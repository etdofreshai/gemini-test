import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

// In-memory cookie store
const store = {};

export function setCookies(obj) {
  Object.assign(store, obj);
}

export function getCookieString() {
  return Object.entries(store)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function hasCookies() {
  return Boolean(store["__Secure-1PSID"] && store["__Secure-1PSIDTS"]);
}

// Bootstrap from process.env / .env file
export function loadFromEnv() {
  if (process.env.GOOGLE_COOKIES) {
    // Parse "key=val; key=val" string into store
    for (const pair of process.env.GOOGLE_COOKIES.split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        store[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
    }
    return;
  }
  const psid = process.env["__Secure-1PSID"];
  const psidts = process.env["__Secure-1PSIDTS"];
  if (psid) store["__Secure-1PSID"] = psid;
  if (psidts) store["__Secure-1PSIDTS"] = psidts;
}

// Update in-memory store (and optionally .env file) from Set-Cookie response headers
export async function refreshCookiesFromResponse(res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  const updates = {};
  for (const sc of setCookies) {
    const match = sc.match(/^(__Secure-1PSID[A-Z]*)=([^;]+)/);
    if (match) updates[match[1]] = match[2];
  }
  if (Object.keys(updates).length === 0) return false;

  // Update in-memory store
  Object.assign(store, updates);

  // Try to persist to .env
  try {
    let envContent = await readFile(ENV_PATH, "utf8");
    let changed = false;
    for (const [key, val] of Object.entries(updates)) {
      const re = new RegExp(
        `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`,
        "m"
      );
      if (re.test(envContent)) {
        envContent = envContent.replace(re, `${key}=${val}`);
        changed = true;
      } else {
        envContent += `\n${key}=${val}`;
        changed = true;
      }
      process.env[key] = val;
    }
    if (changed) {
      await writeFile(ENV_PATH, envContent);
      console.log(
        `  Auto-refreshed cookies: ${Object.keys(updates).join(", ")}`
      );
    }
  } catch {
    // .env may not exist (server mode), that's fine
  }

  return true;
}
