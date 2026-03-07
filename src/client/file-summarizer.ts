import "./style.css";
import { checkAuth, doLogin, summarizeFile } from "./api";

const fileInput = document.getElementById("summary-file-input") as HTMLInputElement;
const fileBtn = document.getElementById("summary-file-btn") as HTMLButtonElement;
const fileName = document.getElementById("summary-file-name") as HTMLSpanElement;
const instructionsInput = document.getElementById("summary-instructions") as HTMLTextAreaElement;
const summarizeBtn = document.getElementById("summarize-btn") as HTMLButtonElement;
const summaryOutput = document.getElementById("summary-output") as HTMLPreElement;
const summaryMeta = document.getElementById("summary-meta") as HTMLDivElement;
const authBanner = document.getElementById("auth-banner")!;
const loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
const toast = document.getElementById("toast")!;

let loading = false;

checkAuthStatus();

fileBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileName.textContent = file ? file.name : "No file selected";
});

loginBtn.addEventListener("click", handleLogin);
summarizeBtn.addEventListener("click", handleSummarize);

async function checkAuthStatus() {
  try {
    const data = await checkAuth();
    authBanner.classList.toggle("visible", !data.authenticated);
  } catch {
    // ignore
  }
}

async function handleLogin() {
  loginBtn.setAttribute("disabled", "");
  loginBtn.textContent = "Opening browser...";
  try {
    const data = await doLogin();
    if (data.success) {
      authBanner.classList.remove("visible");
    }
  } catch {
    showToast("Login request failed");
  } finally {
    loginBtn.removeAttribute("disabled");
    loginBtn.textContent = "Login with Google";
  }
}

async function handleSummarize() {
  if (loading) return;
  const file = fileInput.files?.[0];
  if (!file) {
    showToast("Please choose a file to summarize");
    return;
  }

  loading = true;
  summarizeBtn.disabled = true;
  summarizeBtn.textContent = "Summarizing...";

  try {
    const data = await summarizeFile(file, instructionsInput.value.trim());
    summaryOutput.textContent = cleanRenderedSummary(data.summary);
    summaryMeta.textContent = `Model: ${data.metadata.modelName || "unknown"}${data.metadata.conversationId ? ` • Conversation: ${data.metadata.conversationId}` : ""}`;
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : "Summarization failed");
    await checkAuthStatus();
  } finally {
    loading = false;
    summarizeBtn.disabled = false;
    summarizeBtn.textContent = "Summarize";
  }
}

function cleanRenderedSummary(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "";

  const headingRe = /^###\s+(.+)$/gm;
  const matches = Array.from(text.matchAll(headingRe));
  if (matches.length === 0) return text;

  const sections = new Map<string, { title: string; body: string }>();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const title = m[1].trim();
    const key = title.toLowerCase();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const body = text.slice(start, end).trim();
    if (!body) continue;

    const prev = sections.get(key);
    if (!prev || body.length > prev.body.length) {
      sections.set(key, { title, body });
    }
  }

  const order = ["overview", "key points", "risks/issues", "action items"];
  const out: string[] = [];
  for (const key of order) {
    const s = sections.get(key);
    if (s) out.push(`### ${s.title}\n${s.body}`);
  }
  for (const [key, s] of sections.entries()) {
    if (!order.includes(key)) out.push(`### ${s.title}\n${s.body}`);
  }

  return out.join("\n\n").trim() || text;
}

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 4000);
}
