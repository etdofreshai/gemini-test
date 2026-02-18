import { WebSocket as NodeWebSocket } from "ws";
import {
  ensureChromium,
  cdpNewTab,
  cdpCloseTab,
} from "./browser.js";
import { setCookies } from "./cookies.js";

const GEMINI_APP_URL = "https://gemini.google.com/app";

// Try to restore a Gemini session from the persistent Chrome profile.
// Navigates to Gemini and captures cookies via CDP Network events.
// Returns true if valid auth cookies are found.
export async function tryRestoreSession(): Promise<boolean> {
  try {
    await ensureChromium();

    const tab = await cdpNewTab();
    if (!tab.webSocketDebuggerUrl) return false;

    const capturedCookies: Record<string, string> = {};

    const result = await new Promise<boolean>((resolve) => {
      const ws = new NodeWebSocket(tab.webSocketDebuggerUrl);
      let cmdId = 1;
      let settled = false;

      function send(method: string, params: any = {}) {
        if (ws.readyState === NodeWebSocket.OPEN) {
          ws.send(JSON.stringify({ id: cmdId++, method, params }));
        }
      }

      function finish(success: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        try { ws.close(); } catch {}
        resolve(success);
      }

      const timeoutHandle = setTimeout(() => {
        console.log("[auth] tryRestoreSession: timed out");
        finish(false);
      }, 30000);

      ws.on("open", () => {
        send("Network.enable");
        send("Page.enable");
        send("Page.navigate", { url: GEMINI_APP_URL });
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.method === "Network.requestWillBeSentExtraInfo") {
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
          } else if (msg.method === "Network.responseReceivedExtraInfo") {
            const headers = msg.params.headers || {};
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
          } else if (msg.method === "Page.loadEventFired") {
            // Page loaded — wait briefly for any remaining cookie events then resolve
            setTimeout(() => {
              const hasAll =
                !!(capturedCookies["__Secure-1PSID"] &&
                  capturedCookies["__Secure-1PSIDTS"]);
              finish(hasAll);
            }, 3000);
          }
        } catch {}
      });

      ws.on("error", () => finish(false));
    });

    // Close the tab
    await cdpCloseTab(tab.id).catch(() => {});

    if (
      result &&
      capturedCookies["__Secure-1PSID"] &&
      capturedCookies["__Secure-1PSIDTS"]
    ) {
      setCookies(capturedCookies);
      console.log("[auth] Session restored from Chrome profile.");
      return true;
    }
    return false;
  } catch (err) {
    console.error("[auth] tryRestoreSession error:", err);
    return false;
  }
}
