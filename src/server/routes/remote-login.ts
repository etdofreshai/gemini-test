import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { Router } from "express";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import {
  ensureChromium,
  createLoginScreencast,
  cdpListTabs,
  cdpCloseTab,
} from "../lib/browser.js";
import { setCookies } from "../lib/cookies.js";

const router = Router();
const wss = new WebSocketServer({ noServer: true });

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

type SessionStatus = "idle" | "running" | "success" | "timeout" | "error";

interface LoginSession {
  tabId: string;
  webSocketDebuggerUrl: string;
  status: SessionStatus;
  message: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

let session: LoginSession | null = null;

function closeSession() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timeoutHandle);
  // Close the tab asynchronously
  cdpListTabs()
    .then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === s.tabId) {
          cdpCloseTab(tab.id).catch(() => {});
        }
      }
    })
    .catch(() => {});
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
  closeSession();

  try {
    console.log("[Remote Login] Starting Chromium and creating login tab...");
    const tabInfo = await createLoginScreencast();

    const timeoutHandle = setTimeout(() => {
      if (session && session.status === "running") {
        console.log("[Remote Login] Session timed out.");
        session.status = "timeout";
        session.message = "⏰ Session timed out after 5 minutes.";
        closeSession();
      }
    }, SESSION_TIMEOUT_MS);

    session = {
      tabId: tabInfo.id,
      webSocketDebuggerUrl: tabInfo.webSocketDebuggerUrl,
      status: "running",
      message: "Browser started. Please log in to your Google account.",
      startedAt: Date.now(),
      timeoutHandle,
    };

    console.log("[Remote Login] Session started, tab:", tabInfo.id);
    res.json({ success: true, message: "Browser session started." });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Remote Login] Failed to start:", message);
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
router.post("/remote-login/stop", (_req, res) => {
  closeSession();
  res.json({ success: true });
});

// ── WebSocket upgrade handler (called from index.ts on "upgrade" event) ────────

export function handleRemoteLoginWs(req: IncomingMessage, socket: Socket, head: Buffer) {
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    if (!session || session.status !== "running") {
      clientWs.close(1008, "No active login session");
      return;
    }

    const cdpWsUrl = session.webSocketDebuggerUrl;
    const cdpWs = new NodeWebSocket(cdpWsUrl);
    let cmdId = 1;
    const capturedCookies: Record<string, string> = {};

    function cdpCommand(method: string, params: any = {}) {
      const id = cmdId++;
      if (cdpWs.readyState === NodeWebSocket.OPEN) {
        cdpWs.send(JSON.stringify({ method, params, id }));
      }
      return id;
    }

    function checkAndCapture() {
      if (
        capturedCookies["__Secure-1PSID"] &&
        capturedCookies["__Secure-1PSIDTS"] &&
        session
      ) {
        console.log("[Remote Login] Auth cookies captured successfully!");
        setCookies(capturedCookies);
        session.status = "success";
        session.message = "✅ Login successful! Cookies captured.";
        if (clientWs.readyState === NodeWebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: "success" }));
        }
        // Auto-close after a short delay so UI can show success state
        setTimeout(() => closeSession(), 4000);
      }
    }

    cdpWs.on("open", () => {
      cdpCommand("Page.enable");
      cdpCommand("Network.enable");
      cdpCommand("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: VIEWPORT_WIDTH,
        maxHeight: VIEWPORT_HEIGHT,
      });
    });

    cdpWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.method === "Page.screencastFrame") {
          const { sessionId, metadata } = msg.params;
          // Forward frame to client
          if (clientWs.readyState === NodeWebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: "frame",
                data: msg.params.data,
                metadata,
              })
            );
          }
          // Acknowledge the frame
          cdpCommand("Page.screencastFrameAck", { sessionId });
        } else if (msg.method === "Network.responseReceivedExtraInfo") {
          // Capture cookies from Set-Cookie response headers
          const headers = msg.params.headers || {};
          for (const [name, value] of Object.entries(headers)) {
            if (name.toLowerCase() !== "set-cookie") continue;
            const entries = String(value).split("\n");
            for (const entry of entries) {
              const match = entry.match(/^(__Secure-1PSID[A-Z]*)=([^;]+)/);
              if (match) {
                capturedCookies[match[1]] = match[2];
                console.log(`[Remote Login] Captured ${match[1]} from Set-Cookie`);
              }
            }
          }
          checkAndCapture();
        } else if (msg.method === "Network.requestWillBeSentExtraInfo") {
          // Capture cookies from outgoing request headers
          const params = msg.params;
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
        }
      } catch {}
    });

    // Handle input events from client
    clientWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "click") {
          const { x, y } = msg;
          cdpCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          setTimeout(() => {
            cdpCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            setTimeout(() => {
              cdpCommand("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x,
                y,
                button: "left",
                clickCount: 1,
              });
            }, 50);
          }, 30);
        } else if (msg.type === "keydown") {
          const key = msg.key;
          if (key === "Enter") {
            cdpCommand("Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
            });
            cdpCommand("Input.dispatchKeyEvent", { type: "char", text: "\r" });
            cdpCommand("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
            });
          } else if (key === "Backspace") {
            cdpCommand("Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: "Backspace",
              code: "Backspace",
              windowsVirtualKeyCode: 8,
            });
            cdpCommand("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Backspace",
              code: "Backspace",
              windowsVirtualKeyCode: 8,
            });
          } else if (key === "Tab") {
            cdpCommand("Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: "Tab",
              code: "Tab",
              windowsVirtualKeyCode: 9,
            });
            cdpCommand("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Tab",
              code: "Tab",
              windowsVirtualKeyCode: 9,
            });
          } else if (key === "Escape") {
            cdpCommand("Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
            cdpCommand("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
          } else {
            cdpCommand("Input.dispatchKeyEvent", {
              type: "keyDown",
              key,
              text: key,
            });
            cdpCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
          }
        } else if (msg.type === "type") {
          cdpCommand("Input.insertText", { text: msg.text });
        }
      } catch {}
    });

    const cleanup = () => {
      try { cdpCommand("Page.stopScreencast"); } catch {}
      try { cdpWs.close(); } catch {}
      try { clientWs.close(); } catch {}
    };

    clientWs.on("close", cleanup);
    cdpWs.on("close", () => { try { clientWs.close(); } catch {} });
    cdpWs.on("error", (err) => {
      console.error("[Remote Login] CDP WS error:", err.message);
      try { clientWs.close(); } catch {}
    });
    clientWs.on("error", () => cleanup());
  });
}

// ── Self-contained HTML UI (WebSocket + canvas-based) ─────────────────────────

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

  #canvas-wrap{
    width:100%;max-width:900px;position:relative;
    background:#111;border:1px solid #333;border-radius:8px;overflow:hidden;
    cursor:crosshair;
  }
  #canvas-wrap.inactive{cursor:default}
  #screen{
    display:block;width:100%;height:auto;user-select:none;
  }
  #placeholder{
    width:100%;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;
    color:#555;font-size:1rem;position:absolute;inset:0;
  }
  #click-flash{
    position:absolute;pointer-events:none;border-radius:50%;
    width:24px;height:24px;background:rgba(37,99,235,.6);transform:translate(-50%,-50%);
    display:none;
  }
  #overlay-msg{
    position:absolute;inset:0;display:none;align-items:center;justify-content:center;
    background:rgba(0,0,0,.7);font-size:1.3rem;font-weight:600;color:#fff;
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

<div id="canvas-wrap" class="inactive" onclick="onCanvasClick(event)">
  <canvas id="screen" width="${VIEWPORT_WIDTH}" height="${VIEWPORT_HEIGHT}"></canvas>
  <div id="placeholder">Screenshot will appear here after starting the session.</div>
  <div id="click-flash"></div>
  <div id="overlay-msg"></div>
</div>

<script>
const BASE = '/auth';
let ws = null;
let sessionActive = false;
let startTime = null;
let timerInterval = null;
let hasFirstFrame = false;

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');

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
  document.getElementById('canvas-wrap').classList.toggle('inactive', !enabled);
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

function connectWs() {
  if (ws) { try { ws.close(); } catch {} }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = proto + '//' + location.host + '/auth/remote-login/ws';
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected to screencast');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'frame') {
        // Draw JPEG frame onto canvas
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          if (!hasFirstFrame) {
            hasFirstFrame = true;
            placeholder.style.display = 'none';
          }
        };
        img.src = 'data:image/jpeg;base64,' + msg.data;
      } else if (msg.type === 'success') {
        stopTimer();
        setStatus('✅ Login successful! Cookies captured. Redirecting…', 'success');
        setControlsEnabled(false);
        showOverlay('✅ Login successful! Redirecting…');
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
        setTimeout(() => { window.location.href = '/'; }, 3000);
      }
    } catch(e) {}
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected from screencast');
  };

  ws.onerror = (e) => {
    console.error('[WS] Error', e);
  };
}

async function startSession() {
  document.getElementById('start-btn').disabled = true;
  hasFirstFrame = false;
  setStatus('Starting browser…', 'running');
  try {
    const r = await fetch(BASE + '/remote-login/start', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to start');
    setStatus('Browser started. Connecting to screencast…', 'running');
    setControlsEnabled(true);
    startTimer();
    // Small delay to ensure session is ready before WS connect
    setTimeout(() => {
      connectWs();
      // Poll status for timeout/error detection
      startStatusPolling();
    }, 500);
  } catch(e) {
    setStatus('Error: ' + e.message, 'error');
    document.getElementById('start-btn').disabled = false;
  }
}

async function stopSession() {
  stopTimer();
  stopStatusPolling();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  await fetch(BASE + '/remote-login/stop', { method: 'POST' }).catch(() => {});
  setControlsEnabled(false);
  setStatus('Session stopped.', '');
  document.getElementById('start-btn').disabled = false;
  hasFirstFrame = false;
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Session stopped.';
}

let statusPollTimer = null;
function startStatusPolling() {
  statusPollTimer = setInterval(async () => {
    try {
      const r = await fetch(BASE + '/remote-login/status');
      const data = await r.json();
      if (data.status === 'success') {
        stopStatusPolling();
        // success handled by WS message
      } else if (data.status === 'timeout') {
        stopStatusPolling();
        stopTimer();
        setStatus(data.message, 'timeout');
        setControlsEnabled(false);
        showOverlay('⏰ Timed out. Please try again.');
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
      } else if (data.status === 'error') {
        stopStatusPolling();
        stopTimer();
        setStatus(data.message || 'An error occurred.', 'error');
        setControlsEnabled(false);
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
      } else if (data.status === 'running') {
        // Update message but don't override active status
        if (sessionActive) {
          setStatus(data.message || 'Browser running…', 'running');
        }
      }
    } catch {}
  }, 3000);
}
function stopStatusPolling() {
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function showOverlay(msg) {
  const o = document.getElementById('overlay-msg');
  o.textContent = msg;
  o.style.display = 'flex';
}

function onCanvasClick(event) {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;

  const rect = canvas.getBoundingClientRect();
  const relX = event.clientX - rect.left;
  const relY = event.clientY - rect.top;

  // Map CSS pixels → viewport pixels (1280×${VIEWPORT_HEIGHT})
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const bx = Math.round(relX * scaleX);
  const by = Math.round(relY * scaleY);

  // Show click flash
  const wrap = document.getElementById('canvas-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  const flash = document.getElementById('click-flash');
  flash.style.left = (event.clientX - wrapRect.left) + 'px';
  flash.style.top = (event.clientY - wrapRect.top) + 'px';
  flash.style.display = 'block';
  setTimeout(() => { flash.style.display = 'none'; }, 400);

  ws.send(JSON.stringify({ type: 'click', x: bx, y: by }));
}

function sendType() {
  const input = document.getElementById('type-input');
  const text = input.value;
  if (!text || !sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'type', text }));
  input.value = '';
}

function sendKey(key) {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'keydown', key }));
}

function onInputKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendType();
  }
}

// Allow keyboard typing when canvas is focused
document.addEventListener('keydown', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  // Don't intercept when typing in the input field
  if (document.activeElement === document.getElementById('type-input')) return;
  const specialKeys = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  if (specialKeys.includes(event.key)) {
    event.preventDefault();
    ws.send(JSON.stringify({ type: 'keydown', key: event.key }));
  }
});
</script>
</body>
</html>`;

export default router;
