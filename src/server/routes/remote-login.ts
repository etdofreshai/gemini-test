import { Router } from "express";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page, KeyInput } from "puppeteer";

const puppeteer = puppeteerExtra.default ?? puppeteerExtra;
(puppeteer as any).use(StealthPlugin());
import { setCookies } from "../lib/cookies.js";

const router = Router();

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GOOGLE_LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp";
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

const STEALTH_ARGS = [
  "--no-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled,IsolateOrigins,site-per-process",
  "--disable-dev-shm-usage",
  "--disable-infobars",
  "--window-size=1280,800",
  "--lang=en-US,en",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

const REAL_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type SessionStatus = "running" | "success" | "timeout" | "error";

interface RemoteSession {
  browser: Browser;
  page: Page;
  status: SessionStatus;
  message: string;
  capturedCookies: Record<string, string>;
  timeoutHandle: ReturnType<typeof setTimeout>;
  startedAt: number;
}

let session: RemoteSession | null = null;

async function closeSession() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timeoutHandle);
  try {
    await s.browser.close();
  } catch {
    // ignore
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve self-contained HTML UI
router.get("/remote-login", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(REMOTE_LOGIN_HTML);
});

// Start the browser session
router.post("/remote-login/start", async (_req, res) => {
  if (session && session.status === "running") {
    return res.status(409).json({ error: "Session already running" });
  }

  // Close any stale session
  await closeSession();

  try {
    const browser = await puppeteer.launch({
      headless: "new" as any,
      args: [
        ...STEALTH_ARGS,
        "--enable-features=NetworkService,NetworkServiceInProcess",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    await page.setUserAgent(REAL_USER_AGENT);

    // Extra stealth patches beyond the plugin
    await page.evaluateOnNewDocument(() => {
      // Override webdriver
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      (window.navigator.permissions as any).query = (parameters: any) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);
      // Override plugins to look real
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      // Override languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
      // Chrome runtime
      (window as any).chrome = { runtime: {} };
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });

    const capturedCookies: Record<string, string> = {};

    const checkAndCapture = () => {
      if (
        session &&
        session.status === "running" &&
        capturedCookies["__Secure-1PSID"] &&
        capturedCookies["__Secure-1PSIDTS"]
      ) {
        clearTimeout(session.timeoutHandle);
        setCookies(capturedCookies);
        session.status = "success";
        session.message = "✅ Login successful! Cookies captured. Redirecting…";
        console.log("[Remote Login] Cookies captured successfully.");
        // Auto-close after a short delay so the UI can show the success state
        setTimeout(() => closeSession(), 4000);
      }
    };

    // CDP cookie capture — same logic as loginFlow in auth.ts
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");

    cdp.on("Network.responseReceivedExtraInfo", (params: any) => {
      const headers = params.headers || {};
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== "set-cookie") continue;
        const entries = String(value).split("\n");
        for (const entry of entries) {
          const match = entry.match(/^(__Secure-1PSID[A-Z]*)=([^;]+)/);
          if (match) {
            capturedCookies[match[1]] = match[2];
            console.log(`  [Remote] Captured ${match[1]} (Set-Cookie)`);
          }
        }
      }
      checkAndCapture();
    });

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
      checkAndCapture();
    });

    const timeoutHandle = setTimeout(async () => {
      if (session && session.status === "running") {
        console.log("[Remote Login] Session timed out.");
        session.status = "timeout";
        session.message = "⏰ Session timed out after 5 minutes.";
        await closeSession();
      }
    }, SESSION_TIMEOUT_MS);

    session = {
      browser,
      page,
      status: "running",
      message: "Browser started. Navigating to Gemini…",
      capturedCookies,
      timeoutHandle,
      startedAt: Date.now(),
    };

    // Navigate in background — don't await so the response is immediate
    page
      .goto(GOOGLE_LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 })
      .then(() => {
        if (session && session.status === "running") {
          session.message =
            "Page loaded. Please log in to your Google account.";
        }
      })
      .catch((err: Error) => {
        console.log("[Remote Login] Navigation error:", err.message);
        if (session && session.status === "running") {
          session.message = "Navigation error — try clicking again or wait.";
        }
      });

    res.json({ success: true, message: "Browser session started." });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Remote Login] Failed to start:", message);
    res.status(500).json({ error: message });
  }
});

// Return current screenshot as JPEG
router.get("/remote-login/screenshot", async (_req, res) => {
  if (!session || session.status !== "running") {
    return res.status(404).json({ error: "No active session" });
  }
  try {
    const buf = await session.page.screenshot({ type: "jpeg", quality: 75 });
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(buf));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Screenshot failed";
    res.status(500).json({ error: message });
  }
});

// Click at browser-viewport coordinates
router.post("/remote-login/click", async (req, res) => {
  if (!session || session.status !== "running") {
    return res.status(404).json({ error: "No active session" });
  }
  const { x, y } = req.body as { x: number; y: number };
  if (typeof x !== "number" || typeof y !== "number") {
    return res.status(400).json({ error: "x and y must be numbers" });
  }
  try {
    await session.page.mouse.click(x, y);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Click failed";
    res.status(500).json({ error: message });
  }
});

// Type text into the focused element
router.post("/remote-login/type", async (req, res) => {
  if (!session || session.status !== "running") {
    return res.status(404).json({ error: "No active session" });
  }
  const { text } = req.body as { text: string };
  if (typeof text !== "string") {
    return res.status(400).json({ error: "text must be a string" });
  }
  try {
    await session.page.keyboard.type(text);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Type failed";
    res.status(500).json({ error: message });
  }
});

// Press a named key (Enter, Tab, Backspace, etc.)
router.post("/remote-login/keypress", async (req, res) => {
  if (!session || session.status !== "running") {
    return res.status(404).json({ error: "No active session" });
  }
  const { key } = req.body as { key: string };
  if (typeof key !== "string") {
    return res.status(400).json({ error: "key must be a string" });
  }
  try {
    await session.page.keyboard.press(key as KeyInput);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Keypress failed";
    res.status(500).json({ error: message });
  }
});

// Session status
router.get("/remote-login/status", (_req, res) => {
  if (!session) {
    return res.json({ status: "idle", message: "No session active." });
  }
  const remainingMs = SESSION_TIMEOUT_MS - (Date.now() - session.startedAt);
  res.json({
    status: session.status,
    message: session.message,
    remainingMs: Math.max(0, remainingMs),
  });
});

// Stop / abort the session
router.post("/remote-login/stop", async (_req, res) => {
  await closeSession();
  res.json({ success: true });
});

// ── Self-contained HTML UI ────────────────────────────────────────────────────

const REMOTE_LOGIN_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Remote Browser Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px 8px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:12px;color:#fff}
  #status-bar{
    width:100%;max-width:900px;
    background:#1a1a2e;border:1px solid #333;border-radius:8px;
    padding:10px 16px;margin-bottom:12px;font-size:.9rem;min-height:42px;
    display:flex;align-items:center;gap:8px;
  }
  #status-dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0;transition:background .3s}
  #status-dot.running{background:#22c55e;animation:pulse 1.2s infinite}
  #status-dot.success{background:#22c55e}
  #status-dot.timeout,#status-dot.error{background:#ef4444}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #timer{margin-left:auto;font-size:.8rem;color:#888;white-space:nowrap}

  .controls{
    width:100%;max-width:900px;
    display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center;
  }
  button{
    background:#2563eb;color:#fff;border:none;border-radius:6px;
    padding:8px 16px;cursor:pointer;font-size:.85rem;font-weight:500;
    transition:background .15s;white-space:nowrap;
  }
  button:hover{background:#1d4ed8}
  button:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
  button.danger{background:#dc2626}
  button.danger:hover{background:#b91c1c}
  button.secondary{background:#374151}
  button.secondary:hover{background:#4b5563}
  #type-input{
    flex:1;min-width:180px;background:#1e1e1e;border:1px solid #444;
    color:#e0e0e0;border-radius:6px;padding:8px 12px;font-size:.85rem;
  }
  #type-input:focus{outline:none;border-color:#2563eb}
  .key-group{display:flex;gap:4px}

  #screenshot-wrap{
    width:100%;max-width:900px;position:relative;
    background:#111;border:1px solid #333;border-radius:8px;overflow:hidden;
    cursor:crosshair;
  }
  #screenshot-wrap.inactive{cursor:default}
  #screenshot-img{
    display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none;
  }
  #screenshot-placeholder{
    width:100%;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;
    color:#555;font-size:1rem;
  }
  #click-flash{
    position:absolute;pointer-events:none;border-radius:50%;
    width:24px;height:24px;background:rgba(37,99,235,.6);transform:translate(-50%,-50%);
    display:none;
  }
  #overlay-msg{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.7);font-size:1.3rem;font-weight:600;color:#fff;
    display:none;
  }
</style>
</head>
<body>
<h1>🖥️ Remote Browser Login</h1>

<div id="status-bar">
  <span id="status-dot"></span>
  <span id="status-text">Click "Start Login" to open the browser.</span>
  <span id="timer"></span>
</div>

<div class="controls">
  <button id="start-btn" onclick="startSession()">▶ Start Login</button>
  <button id="stop-btn" class="danger" onclick="stopSession()" disabled>■ Stop</button>
  <input id="type-input" type="text" placeholder="Type text here…" onkeydown="onInputKey(event)"/>
  <button id="type-btn" onclick="sendType()" disabled>⌨ Type</button>
  <div class="key-group">
    <button class="secondary" onclick="sendKey('Enter')" disabled id="key-enter">↵ Enter</button>
    <button class="secondary" onclick="sendKey('Tab')" disabled id="key-tab">⇥ Tab</button>
    <button class="secondary" onclick="sendKey('Backspace')" disabled id="key-bs">⌫ Back</button>
    <button class="secondary" onclick="sendKey('Escape')" disabled id="key-esc">Esc</button>
  </div>
</div>

<div id="screenshot-wrap" class="inactive" onclick="onScreenshotClick(event)">
  <div id="screenshot-placeholder">Screenshot will appear here after starting the session.</div>
  <img id="screenshot-img" src="" alt="" style="display:none"/>
  <div id="click-flash"></div>
  <div id="overlay-msg"></div>
</div>

<script>
const BASE = '/auth';
let polling = false;
let pollTimer = null;
let timerInterval = null;
let sessionActive = false;
let startTime = null;

function setStatus(text, dotClass) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  dot.className = dotClass || '';
}

function setControlsEnabled(enabled) {
  sessionActive = enabled;
  document.getElementById('stop-btn').disabled = !enabled;
  document.getElementById('type-btn').disabled = !enabled;
  ['key-enter','key-tab','key-bs','key-esc'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
  document.getElementById('screenshot-wrap').classList.toggle('inactive', !enabled);
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    if (!startTime) return;
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 300000 - elapsed);
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    document.getElementById('timer').textContent = remaining > 0
      ? \`⏱ \${m}:\${s.toString().padStart(2,'0')} left\`
      : '';
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.getElementById('timer').textContent = '';
}

async function startSession() {
  document.getElementById('start-btn').disabled = true;
  setStatus('Starting browser…', 'running');
  try {
    const r = await fetch(BASE + '/remote-login/start', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to start');
    setStatus('Browser started. Waiting for page load…', 'running');
    setControlsEnabled(true);
    startTimer();
    startPolling();
  } catch(e) {
    setStatus('Error: ' + e.message, 'error');
    document.getElementById('start-btn').disabled = false;
  }
}

async function stopSession() {
  stopPolling();
  stopTimer();
  await fetch(BASE + '/remote-login/stop', { method: 'POST' }).catch(() => {});
  setControlsEnabled(false);
  setStatus('Session stopped.', '');
  document.getElementById('start-btn').disabled = false;
  showPlaceholder('Session stopped.');
}

function startPolling() {
  if (polling) return;
  polling = true;
  pollStep();
}

function stopPolling() {
  polling = false;
  clearTimeout(pollTimer);
}

async function pollStep() {
  if (!polling) return;

  // Check status
  try {
    const r = await fetch(BASE + '/remote-login/status');
    const data = await r.json();
    if (data.status === 'success') {
      polling = false;
      stopTimer();
      setStatus(data.message, 'success');
      setControlsEnabled(false);
      showOverlay('✅ Login successful! Redirecting…');
      document.getElementById('start-btn').disabled = false;
      setTimeout(() => { window.location.href = '/'; }, 3000);
      return;
    } else if (data.status === 'timeout') {
      polling = false;
      stopTimer();
      setStatus(data.message, 'timeout');
      setControlsEnabled(false);
      showOverlay('⏰ Timed out. Please try again.');
      document.getElementById('start-btn').disabled = false;
      return;
    } else if (data.status === 'error') {
      polling = false;
      stopTimer();
      setStatus(data.message || 'An error occurred.', 'error');
      setControlsEnabled(false);
      document.getElementById('start-btn').disabled = false;
      return;
    } else if (data.status === 'running') {
      setStatus(data.message || 'Browser running…', 'running');
    }
  } catch(e) {
    // status check failed, continue
  }

  // Fetch screenshot
  try {
    const r = await fetch(BASE + '/remote-login/screenshot?t=' + Date.now());
    if (r.ok) {
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const img = document.getElementById('screenshot-img');
      const old = img.src;
      img.src = url;
      img.style.display = 'block';
      document.getElementById('screenshot-placeholder').style.display = 'none';
      if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
    }
  } catch(e) {
    // screenshot failed, continue
  }

  if (polling) {
    pollTimer = setTimeout(pollStep, 500);
  }
}

function showPlaceholder(msg) {
  document.getElementById('screenshot-img').style.display = 'none';
  const ph = document.getElementById('screenshot-placeholder');
  ph.style.display = 'flex';
  ph.textContent = msg;
}

function showOverlay(msg) {
  const o = document.getElementById('overlay-msg');
  o.textContent = msg;
  o.style.display = 'flex';
}

function onScreenshotClick(event) {
  if (!sessionActive) return;
  const wrap = document.getElementById('screenshot-wrap');
  const img = document.getElementById('screenshot-img');
  if (img.style.display === 'none') return;

  const rect = img.getBoundingClientRect();
  const relX = event.clientX - rect.left;
  const relY = event.clientY - rect.top;

  // Map to actual browser viewport (1280×800)
  const scaleX = ${VIEWPORT_WIDTH} / rect.width;
  const scaleY = ${VIEWPORT_HEIGHT} / rect.height;
  const bx = Math.round(relX * scaleX);
  const by = Math.round(relY * scaleY);

  // Show click flash
  const flash = document.getElementById('click-flash');
  const wrapRect = wrap.getBoundingClientRect();
  flash.style.left = (event.clientX - wrapRect.left) + 'px';
  flash.style.top = (event.clientY - wrapRect.top) + 'px';
  flash.style.display = 'block';
  setTimeout(() => { flash.style.display = 'none'; }, 400);

  fetch(BASE + '/remote-login/click', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ x: bx, y: by })
  }).catch(console.error);
}

function sendType() {
  const input = document.getElementById('type-input');
  const text = input.value;
  if (!text || !sessionActive) return;
  fetch(BASE + '/remote-login/type', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text })
  }).catch(console.error);
  input.value = '';
}

function sendKey(key) {
  if (!sessionActive) return;
  fetch(BASE + '/remote-login/keypress', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ key })
  }).catch(console.error);
}

function onInputKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendType();
  }
}
</script>
</body>
</html>`;

export default router;
