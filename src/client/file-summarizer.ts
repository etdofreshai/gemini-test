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
    summaryOutput.textContent = data.summary;
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

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 4000);
}
