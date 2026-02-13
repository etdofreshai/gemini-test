import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import { setCookies } from "./cookies.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, "..", ".chrome-profile");

const GEMINI_APP_URL = "https://gemini.google.com/app";

// Chrome args to avoid Google's automation detection on the login page
const STEALTH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled",
];

// Patch navigator.webdriver so Google doesn't flag us as a bot
async function applyStealthPatches(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // Remove the "cdc_" property that ChromeDriver injects
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  });
}

// Parse a raw "key=val; key=val" cookie string and extract __Secure-1PSID* keys
function parseCookieString(cookieStr) {
  const store = {};
  for (const pair of cookieStr.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name.startsWith("__Secure-1PSID")) {
        store[name] = value;
      }
    }
  }
  return store;
}

// Launch a visible browser for manual Google login, wait for Gemini session,
// extract cookies, and close the browser.
export async function loginFlow() {
  console.log("Launching browser for Google login...");
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    args: STEALTH_ARGS,
  });

  const page = await browser.newPage();
  await applyStealthPatches(page);

  // Set up CDP listener BEFORE navigating — capture cookie headers from all
  // requests to gemini.google.com as they happen.
  let capturedCookieHeader = null;
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (params) => {
    if (params.request.url.includes("gemini.google.com")) {
      const h =
        params.request.headers["Cookie"] ||
        params.request.headers["cookie"];
      if (h && h.includes("__Secure-1PSID")) {
        capturedCookieHeader = h;
      }
    }
  });

  await page.goto(GEMINI_APP_URL, { waitUntil: "networkidle2" });

  console.log("Waiting for login...");
  console.log("  (URL must be on gemini.google.com AND page must contain SNlM0e)");

  const maxWait = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 2000;
  const start = Date.now();
  let loggedIn = false;

  while (Date.now() - start < maxWait) {
    try {
      const url = page.url();
      // Only check for SNlM0e when we're actually on Gemini, not on accounts.google.com
      if (url.includes("gemini.google.com")) {
        const html = await page.content();
        if (html.includes('"SNlM0e"')) {
          loggedIn = true;
          break;
        }
      }
    } catch {
      // Page may be navigating
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  await cdp.detach().catch(() => {});

  if (!loggedIn) {
    await browser.close();
    throw new Error("Login timed out after 5 minutes");
  }

  console.log("Login detected!");

  // If we already captured cookies from the initial navigation, use them.
  // Otherwise reload to trigger a new request and capture fresh cookies.
  if (!capturedCookieHeader) {
    console.log("  No cookies captured yet, reloading to intercept...");
    const cdp2 = await page.createCDPSession();
    await cdp2.send("Network.enable");

    const cookiePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Cookie intercept timed out")), 15000);
      cdp2.on("Network.requestWillBeSent", (params) => {
        if (params.request.url.includes("gemini.google.com")) {
          const h =
            params.request.headers["Cookie"] ||
            params.request.headers["cookie"];
          if (h && h.includes("__Secure-1PSID")) {
            clearTimeout(timeout);
            resolve(h);
          }
        }
      });
    });

    page.reload({ waitUntil: "networkidle2" }).catch(() => {});
    try {
      capturedCookieHeader = await cookiePromise;
    } catch {
      // fall through
    }
    await cdp2.detach().catch(() => {});
  }

  await browser.close();

  if (!capturedCookieHeader) {
    throw new Error(
      "Login succeeded but could not capture cookie header from browser requests"
    );
  }

  console.log(`  Cookie header length: ${capturedCookieHeader.length}`);
  const store = parseCookieString(capturedCookieHeader);
  console.log(`  Matched keys: ${Object.keys(store).join(", ") || "(none)"}`);

  if (!store["__Secure-1PSID"] || !store["__Secure-1PSIDTS"]) {
    throw new Error(
      "Login succeeded but __Secure-1PSID or __Secure-1PSIDTS missing from cookie header"
    );
  }

  setCookies(store);
  console.log("Cookies extracted successfully.");
  return true;
}

// Try to restore a session from the persistent Chrome profile (headless).
// Returns true if cookies were extracted, false if login is needed.
export async function tryRestoreSession() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      userDataDir: PROFILE_DIR,
      args: STEALTH_ARGS,
    });

    const page = await browser.newPage();
    await applyStealthPatches(page);

    // Capture cookies from the initial navigation
    let capturedCookieHeader = null;
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (params) => {
      if (params.request.url.includes("gemini.google.com")) {
        const h =
          params.request.headers["Cookie"] ||
          params.request.headers["cookie"];
        if (h && h.includes("__Secure-1PSID")) {
          capturedCookieHeader = h;
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

    if (!capturedCookieHeader) return false;

    const store = parseCookieString(capturedCookieHeader);
    if (store["__Secure-1PSID"] && store["__Secure-1PSIDTS"]) {
      setCookies(store);
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
