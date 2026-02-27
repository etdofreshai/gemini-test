import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", "..", "..", ".env");

// Persistent cookie file — survives container restarts (lives in mounted volume)
const CHROME_PROFILE_DIR = path.join(process.cwd(), ".chrome-profile");
const COOKIES_FILE_PATH = path.join(CHROME_PROFILE_DIR, "session-cookies.json");

// In-memory cookie store
const store: Record<string, string> = {};

export function setCookies(obj: Record<string, string>) {
  Object.assign(store, obj);
}

export function getCookieString(): string {
  return Object.entries(store)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function hasCookies(): boolean {
  return Boolean(store["__Secure-1PSID"] && store["__Secure-1PSIDTS"]);
}

// ── Persistent file-based cookie storage ──────────────────────────────────────

/**
 * Save the current in-memory cookie store to the persistent session file.
 * Called after every successful login / cookie capture so cookies survive
 * container restarts without needing .env values.
 */
export async function saveCookiesToFile(): Promise<void> {
  try {
    // Ensure the profile directory exists (may not be present on first run)
    await mkdir(CHROME_PROFILE_DIR, { recursive: true });
    const data = JSON.stringify(store, null, 2);
    await writeFile(COOKIES_FILE_PATH, data, "utf8");
    console.log("[cookies] Session cookies persisted to", COOKIES_FILE_PATH);
  } catch (err) {
    console.error("[cookies] Failed to save session cookies to file:", err);
  }
}

/**
 * Load cookies from the persistent session file.
 * Used as a startup fallback when no cookies are present in the environment.
 * Returns true if valid auth cookies (__Secure-1PSID + __Secure-1PSIDTS) were loaded.
 */
export async function loadCookiesFromFile(): Promise<boolean> {
  try {
    const data = await readFile(COOKIES_FILE_PATH, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.warn("[cookies] session-cookies.json is not valid JSON — ignoring.");
      return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("[cookies] session-cookies.json has unexpected format — ignoring.");
      return false;
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([k, v]) => typeof k === "string" && typeof v === "string"
    ) as [string, string][];
    if (entries.length === 0) {
      console.warn("[cookies] session-cookies.json contains no valid string entries.");
      return false;
    }
    Object.assign(store, Object.fromEntries(entries));
    const ok = hasCookies();
    if (ok) {
      console.log("[cookies] Auth cookies loaded from persisted file:", COOKIES_FILE_PATH);
    } else {
      console.warn("[cookies] session-cookies.json loaded but required cookies are missing.");
    }
    return ok;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // No persisted file yet — this is normal on first run
      return false;
    }
    console.error("[cookies] Failed to read session-cookies.json:", err);
    return false;
  }
}

// ── Bootstrap from process.env / .env file ────────────────────────────────────

// Bootstrap from process.env / .env file
export function loadFromEnv() {
  if (process.env.GOOGLE_COOKIES) {
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
export async function refreshCookiesFromResponse(res: Response) {
  const setCookieHeaders = res.headers.getSetCookie?.() || [];
  const updates: Record<string, string> = {};
  for (const sc of setCookieHeaders) {
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

  // Always persist the updated cookies to the session file so they survive restarts
  await saveCookiesToFile();

  return true;
}
