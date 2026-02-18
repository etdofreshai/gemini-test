import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page } from "puppeteer";

puppeteer.use(StealthPlugin());
import path from "path";
import { fileURLToPath } from "url";
import { setCookies } from "./cookies.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, "..", "..", "..", ".chrome-profile");

const GEMINI_APP_URL = "https://gemini.google.com/app";

const STEALTH_ARGS = [
  "--no-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
];

async function applyStealthPatches(page: Page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  });
}

// Launch a visible browser for manual Google login.
// Captures cookies from Set-Cookie response headers during the login flow.
export async function loginFlow() {
  console.log("Launching browser for Google login...");
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    args: STEALTH_ARGS,
  });

  const page = await browser.newPage();
  await applyStealthPatches(page);

  // Set up CDP to capture Set-Cookie headers from responses BEFORE navigating.
  // This catches cookies as Google sets them during the login/redirect flow.
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");

  const capturedCookies: Record<string, string> = {};

  // Capture from Set-Cookie response headers
  cdp.on("Network.responseReceivedExtraInfo", (params: any) => {
    const headers = params.headers || {};
    // Response headers can have multiple set-cookie entries
    // In CDP, they're sometimes concatenated or in an array
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "set-cookie") continue;
      // Value might be a single string or newline-separated for multiple cookies
      const entries = String(value).split("\n");
      for (const entry of entries) {
        const match = entry.match(/^(__Secure-1PSID[A-Z]*)=([^;]+)/);
        if (match) {
          capturedCookies[match[1]] = match[2];
          console.log(`  [Set-Cookie] Captured ${match[1]}`);
        }
      }
    }
  });

  // Also capture from request Cookie headers (in case cookies are already set)
  cdp.on("Network.requestWillBeSentExtraInfo", (params: any) => {
    if (Array.isArray(params.associatedCookies)) {
      for (const entry of params.associatedCookies) {
        const c = entry.cookie;
        if (c?.name?.startsWith("__Secure-1PSID") && c.value) {
          capturedCookies[c.name] = c.value;
        }
      }
    }
    const h = params.headers?.["cookie"] || params.headers?.["Cookie"];
    if (h && h.includes("__Secure-1PSID")) {
      for (const pair of h.split(";")) {
        const idx = pair.indexOf("=");
        if (idx > 0) {
          const name = pair.slice(0, idx).trim();
          const val = pair.slice(idx + 1).trim();
          if (name.startsWith("__Secure-1PSID") && val) {
            capturedCookies[name] = val;
          }
        }
      }
    }
  });

  // Navigate to Gemini (will redirect to Google login if not authenticated)
  await page.goto(GEMINI_APP_URL, { waitUntil: "networkidle2" });

  console.log("Waiting for login...");
  console.log("  Log in to your Google account in the browser window.");

  const maxWait = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 2000;
  const start = Date.now();
  let loggedIn = false;

  while (Date.now() - start < maxWait) {
    // Check if we already captured the cookies we need
    if (capturedCookies["__Secure-1PSID"] && capturedCookies["__Secure-1PSIDTS"]) {
      loggedIn = true;
      console.log("  Cookies captured from login flow!");
      break;
    }

    // Also check if we're on Gemini with a valid session
    try {
      const url = page.url();
      if (url.includes("gemini.google.com")) {
        const html = await page.content();
        if (html.includes('"SNlM0e"')) {
          // Page has SNlM0e — but only trust this if we also have cookies
          if (
            capturedCookies["__Secure-1PSID"] ||
            capturedCookies["__Secure-1PSIDTS"]
          ) {
            loggedIn = true;
            break;
          }
          // SNlM0e without cookies means cached page — wait for fresh cookies
          console.log("  Page loaded but waiting for fresh cookies...");
        }
      }
    } catch {
      // Page may be navigating
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  await cdp.detach().catch(() => {});
  await browser.close();

  if (
    !capturedCookies["__Secure-1PSID"] ||
    !capturedCookies["__Secure-1PSIDTS"]
  ) {
    if (!loggedIn) {
      throw new Error("Login timed out after 5 minutes");
    }
    throw new Error(
      "Login detected but __Secure-1PSID cookies were not captured. " +
        `Got: ${Object.keys(capturedCookies).join(", ") || "(none)"}`
    );
  }

  console.log(`  Cookie keys: ${Object.keys(capturedCookies).join(", ")}`);
  setCookies(capturedCookies);
  console.log("Cookies extracted successfully.");
  return true;
}

// Try to restore a session from the persistent Chrome profile (headless).
export async function tryRestoreSession(): Promise<boolean> {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: PROFILE_DIR,
      args: STEALTH_ARGS,
    });

    const page = await browser.newPage();
    await applyStealthPatches(page);

    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");

    const capturedCookies: Record<string, string> = {};

    cdp.on("Network.requestWillBeSentExtraInfo", (params: any) => {
      if (Array.isArray(params.associatedCookies)) {
        for (const entry of params.associatedCookies) {
          const c = entry.cookie;
          if (c?.name?.startsWith("__Secure-1PSID") && c.value) {
            capturedCookies[c.name] = c.value;
          }
        }
      }
      const h = params.headers?.["cookie"] || params.headers?.["Cookie"];
      if (h && h.includes("__Secure-1PSID")) {
        for (const pair of h.split(";")) {
          const idx = pair.indexOf("=");
          if (idx > 0) {
            const name = pair.slice(0, idx).trim();
            const val = pair.slice(idx + 1).trim();
            if (name.startsWith("__Secure-1PSID") && val) {
              capturedCookies[name] = val;
            }
          }
        }
      }
    });

    cdp.on("Network.responseReceivedExtraInfo", (params: any) => {
      const headers = params.headers || {};
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== "set-cookie") continue;
        const entries = String(value).split("\n");
        for (const entry of entries) {
          const match = entry.match(/^(__Secure-1PSID[A-Z]*)=([^;]+)/);
          if (match) {
            capturedCookies[match[1]] = match[2];
          }
        }
      }
    });

    await page.goto(GEMINI_APP_URL, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    await cdp.detach().catch(() => {});

    const url = page.url();
    const html = await page.content();
    await browser.close();

    if (!url.includes("gemini.google.com") || !html.includes('"SNlM0e"')) {
      return false;
    }

    if (
      capturedCookies["__Secure-1PSID"] &&
      capturedCookies["__Secure-1PSIDTS"]
    ) {
      setCookies(capturedCookies);
      return true;
    }
    return false;
  } catch {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    return false;
  }
}
