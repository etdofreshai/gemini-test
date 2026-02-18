import "./style.css";
import { checkAuth, doLogin, generate, upscale, type GeneratedImage } from "./api";

const grid = document.getElementById("image-grid")!;
const emptyState = document.getElementById("empty-state")!;
const promptInput = document.getElementById("prompt-input") as HTMLInputElement;
const submitBtn = document.getElementById("submit-btn")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const fileBtn = document.getElementById("file-btn")!;
const fileCount = document.getElementById("file-count")!;
const authBanner = document.getElementById("auth-banner")!;
const loginBtn = document.getElementById("login-btn")!;
const toast = document.getElementById("toast")!;
const aspectRatioSelect = document.getElementById("aspect-ratio") as HTMLSelectElement;

let generating = false;

// Check auth on load
checkAuthStatus();

// Submit on Enter
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleGenerate();
  }
});

// Wire up buttons
submitBtn.addEventListener("click", handleGenerate);
loginBtn.addEventListener("click", handleLogin);
fileBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", onFilesChanged);

function onFilesChanged() {
  const count = fileInput.files?.length ?? 0;
  fileBtn.classList.toggle("has-files", count > 0);
  fileCount.textContent = String(count);
}

async function checkAuthStatus() {
  try {
    const data = await checkAuth();
    authBanner.classList.toggle("visible", !data.authenticated);
  } catch {
    // Server may be down
  }
}

async function handleLogin() {
  loginBtn.setAttribute("disabled", "");
  loginBtn.textContent = "Opening browser...";
  try {
    const data = await doLogin();
    if (data.success) {
      authBanner.classList.remove("visible");
    } else {
      showToast(data.error || "Login failed");
    }
  } catch {
    showToast("Login request failed");
  } finally {
    loginBtn.removeAttribute("disabled");
    loginBtn.textContent = "Login with Google";
  }
}

async function handleGenerate() {
  const prompt = promptInput.value.trim();
  if (!prompt || generating) return;

  generating = true;
  submitBtn.setAttribute("disabled", "");
  submitBtn.innerHTML = '<div class="spinner"></div>';

  try {
    const data = await generate(
      prompt,
      fileInput.files,
      aspectRatioSelect.value || undefined
    );

    if (!data.images || data.images.length === 0) {
      showToast("No images returned");
      return;
    }

    // Hide empty state
    emptyState.style.display = "none";

    // Add images to grid (newest first)
    for (const img of data.images) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.addEventListener("click", (e) => {
        // Don't open image if clicking the upscale button
        if ((e.target as HTMLElement).closest(".upscale-btn")) return;
        window.open(img.url, "_blank");
      });

      const imgEl = document.createElement("img");
      imgEl.src = img.url;
      imgEl.alt = img.filename;

      const overlay = document.createElement("div");
      overlay.className = "overlay";
      const dims = img.dimensions
        ? ` \u2022 ${img.dimensions[0]}\u00D7${img.dimensions[1]}`
        : "";
      overlay.textContent = `${img.filename}${dims}`;

      tile.appendChild(imgEl);
      tile.appendChild(overlay);

      // Add upscale button if the image has upscale metadata
      if (img.imageToken && img.responseChunkId && data.metadata.conversationId && data.metadata.responseId) {
        const btn = createUpscaleBtn(img, data.metadata as any, imgEl, tile);
        tile.appendChild(btn);
      }

      grid.prepend(tile);
    }

    // Clear inputs
    promptInput.value = "";
    fileInput.value = "";
    onFilesChanged();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Request failed";
    showToast(message);
    checkAuthStatus();
  } finally {
    generating = false;
    submitBtn.removeAttribute("disabled");
    submitBtn.innerHTML = "&#10148;";
  }
}

function createUpscaleBtn(
  img: GeneratedImage,
  metadata: { conversationId: string; responseId: string; prompt: string },
  imgEl: HTMLImageElement,
  tile: HTMLDivElement
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "upscale-btn";
  btn.textContent = "2K";

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (btn.classList.contains("done") || btn.hasAttribute("disabled")) return;

    btn.setAttribute("disabled", "");
    btn.textContent = "Upscaling...";

    try {
      const result = await upscale({
        imageToken: img.imageToken!,
        responseChunkId: img.responseChunkId!,
        conversationId: metadata.conversationId,
        responseId: metadata.responseId,
        prompt: metadata.prompt,
      });

      // Replace the preview with the full-size image
      imgEl.src = result.url;

      // Update the tile click handler to open the full-size image
      tile.onclick = (ev) => {
        if ((ev.target as HTMLElement).closest(".upscale-btn")) return;
        window.open(result.url, "_blank");
      };

      // Update overlay with file size
      const overlay = tile.querySelector(".overlay");
      if (overlay) {
        const sizeMB = (result.bytes / 1024 / 1024).toFixed(1);
        overlay.textContent = `${img.filename} \u2022 2K \u2022 ${sizeMB} MB`;
      }

      btn.textContent = "2K \u2713";
      btn.classList.add("done");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Upscale failed";
      showToast(message);
      btn.textContent = "2K";
    } finally {
      btn.removeAttribute("disabled");
    }
  });

  return btn;
}

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 5000);
}
