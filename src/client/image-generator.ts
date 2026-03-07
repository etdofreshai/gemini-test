import "./style.css";
import {
  checkAuth,
  doLogin,
  generate,
  upscale,
  listImages,
  deleteImage,
  deleteImages,
  type GeneratedImage,
  type StoredImage,
} from "./api";

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

// Selection mode elements
const selectModeBtn = document.getElementById("select-mode-btn")!;
const selectionToolbar = document.getElementById("selection-toolbar")!;
const selectAllBtn = document.getElementById("select-all-btn")!;
const deleteSelectedBtn = document.getElementById("delete-selected-btn")!;
const cancelSelectBtn = document.getElementById("cancel-select-btn")!;
const selectedCount = document.getElementById("selected-count")!;

let generating = false;
let selectionMode = false;
const selectedFiles = new Set<string>();

// Check auth on load
checkAuthStatus();

// Load existing images on startup
loadExistingImages();

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

// Selection mode
selectModeBtn.addEventListener("click", toggleSelectionMode);
cancelSelectBtn.addEventListener("click", exitSelectionMode);
selectAllBtn.addEventListener("click", selectAll);
deleteSelectedBtn.addEventListener("click", handleDeleteSelected);

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

async function loadExistingImages() {
  try {
    const data = await listImages();
    if (!data.images || data.images.length === 0) return;

    emptyState.style.display = "none";

    // Add images from storage (already sorted newest first by server)
    for (const img of data.images) {
      const tile = createStoredImageTile(img);
      grid.appendChild(tile);
    }
  } catch {
    // Non-critical — grid starts empty
  }
}

function createStoredImageTile(img: StoredImage): HTMLDivElement {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.filename = img.filename;
  if (img.prompt) tile.dataset.prompt = img.prompt;
  if (img.aspectRatio) tile.dataset.aspectRatio = img.aspectRatio;

  tile.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".delete-btn")) return;
    if ((e.target as HTMLElement).closest(".tile-checkbox")) return;
    if (selectionMode) {
      toggleTileSelection(tile, img.filename);
      return;
    }
    // Open modal instead of new tab
    openImageModal(img.url, img.prompt, img.aspectRatio, img.filename);
  });

  const imgEl = document.createElement("img");
  imgEl.src = img.url;
  imgEl.alt = img.filename;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  
  // Build overlay text with prompt preview + aspect ratio
  const overlayParts: string[] = [];
  if (img.prompt) {
    const truncated = img.prompt.length > 60 ? img.prompt.slice(0, 60) + "…" : img.prompt;
    overlayParts.push(truncated);
  } else {
    overlayParts.push(img.filename);
  }
  const sizeMB = img.bytes > 0 ? ` • ${(img.bytes / 1024 / 1024).toFixed(1)} MB` : "";
  if (img.aspectRatio) {
    overlayParts.push(`[${img.aspectRatio}]`);
  }
  overlay.textContent = overlayParts.join(" ") + sizeMB;

  const deleteBtn = createDeleteBtn(img.filename, tile);
  const checkbox = createCheckbox(img.filename, tile);

  tile.appendChild(checkbox);
  tile.appendChild(imgEl);
  tile.appendChild(overlay);
  tile.appendChild(deleteBtn);

  return tile;
}

function createDeleteBtn(filename: string, tile: HTMLDivElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "delete-btn";
  btn.title = "Delete image";
  btn.innerHTML = "🗑";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete ${filename}?`)) return;
    try {
      await deleteImage(filename);
      tile.remove();
      selectedFiles.delete(filename);
      updateSelectionUI();
      if (grid.children.length === 0) {
        emptyState.style.display = "";
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : "Delete failed");
    }
  });
  return btn;
}

function createCheckbox(filename: string, tile: HTMLDivElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "tile-checkbox";
  label.addEventListener("click", (e) => e.stopPropagation());

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.addEventListener("change", () => {
    if (cb.checked) {
      selectedFiles.add(filename);
      tile.classList.add("selected");
    } else {
      selectedFiles.delete(filename);
      tile.classList.remove("selected");
    }
    updateSelectionUI();
  });

  label.appendChild(cb);
  return label;
}

function toggleTileSelection(tile: HTMLDivElement, filename: string) {
  const cb = tile.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (!cb) return;
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event("change"));
}

function toggleSelectionMode() {
  if (selectionMode) {
    exitSelectionMode();
  } else {
    enterSelectionMode();
  }
}

function enterSelectionMode() {
  selectionMode = true;
  selectedFiles.clear();
  document.body.classList.add("selection-mode");
  selectionToolbar.classList.add("visible");
  selectModeBtn.textContent = "✕ Cancel";
  // Uncheck all
  document.querySelectorAll<HTMLInputElement>(".tile input[type=checkbox]").forEach((cb) => {
    cb.checked = false;
    cb.closest(".tile")?.classList.remove("selected");
  });
  updateSelectionUI();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedFiles.clear();
  document.body.classList.remove("selection-mode");
  selectionToolbar.classList.remove("visible");
  selectModeBtn.textContent = "☑ Select";
  document.querySelectorAll<HTMLInputElement>(".tile input[type=checkbox]").forEach((cb) => {
    cb.checked = false;
    cb.closest(".tile")?.classList.remove("selected");
  });
  updateSelectionUI();
}

function selectAll() {
  document.querySelectorAll<HTMLDivElement>(".tile[data-filename]").forEach((tile) => {
    const filename = tile.dataset.filename!;
    const cb = tile.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (cb && !cb.checked) {
      cb.checked = true;
      selectedFiles.add(filename);
      tile.classList.add("selected");
    }
  });
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedFiles.size;
  selectedCount.textContent = `${count} selected`;
  deleteSelectedBtn.toggleAttribute("disabled", count === 0);
}

async function handleDeleteSelected() {
  const files = Array.from(selectedFiles);
  if (files.length === 0) return;
  if (!confirm(`Delete ${files.length} image${files.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;

  try {
    const result = await deleteImages(files);
    // Remove deleted tiles from DOM
    for (const filename of result.deleted) {
      const tile = document.querySelector<HTMLElement>(`.tile[data-filename="${CSS.escape(filename)}"]`);
      tile?.remove();
    }
    if (result.errors.length > 0) {
      showToast(`Deleted ${result.deleted.length}, errors: ${result.errors.join("; ")}`);
    }
    exitSelectionMode();
    if (grid.children.length === 0) {
      emptyState.style.display = "";
    }
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : "Delete failed");
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
      if (data.textContent) {
        openTextModal(data.textContent, prompt);
      } else {
        showToast("No images returned");
      }
      return;
    }

    // Hide empty state
    emptyState.style.display = "none";

    // Add images to grid (newest first)
    for (const img of data.images) {
      const tile = createGeneratedImageTile(img, data.metadata as any);
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

function createGeneratedImageTile(
  img: GeneratedImage,
  metadata: { conversationId: string | null; responseId: string | null; prompt: string }
): HTMLDivElement {
  // Use savedName (uuid-based filename in storage) for deletion
  const savedName = img.savedName || img.url.split("/").pop() || img.filename;
  const promptText = img.prompt || metadata.prompt;
  const aspectRatioText = img.aspectRatio;

  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.filename = savedName;
  if (promptText) tile.dataset.prompt = promptText;
  if (aspectRatioText) tile.dataset.aspectRatio = aspectRatioText;

  tile.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".upscale-btn")) return;
    if ((e.target as HTMLElement).closest(".delete-btn")) return;
    if ((e.target as HTMLElement).closest(".tile-checkbox")) return;
    if (selectionMode) {
      toggleTileSelection(tile, savedName);
      return;
    }
    // Open modal instead of new tab
    openImageModal(img.url, promptText, aspectRatioText, img.filename);
  });

  const imgEl = document.createElement("img");
  imgEl.src = img.url;
  imgEl.alt = img.filename;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  
  // Build overlay text with prompt preview + aspect ratio
  const overlayParts: string[] = [];
  if (promptText) {
    const truncated = promptText.length > 60 ? promptText.slice(0, 60) + "…" : promptText;
    overlayParts.push(truncated);
  } else {
    overlayParts.push(img.filename);
  }
  const dims = img.dimensions ? ` • ${img.dimensions[0]}\u00D7${img.dimensions[1]}` : "";
  if (aspectRatioText) {
    overlayParts.push(`[${aspectRatioText}]`);
  }
  overlay.textContent = overlayParts.join(" ") + dims;

  const deleteBtn = createDeleteBtn(savedName, tile);
  const checkbox = createCheckbox(savedName, tile);

  tile.appendChild(checkbox);
  tile.appendChild(imgEl);
  tile.appendChild(overlay);
  tile.appendChild(deleteBtn);

  // Add upscale button if the image has upscale metadata
  if (img.imageToken && img.responseChunkId && metadata.conversationId && metadata.responseId) {
    const btn = createUpscaleBtn(img, metadata as any, imgEl, tile, overlay);
    tile.appendChild(btn);
  }

  return tile;
}

function createUpscaleBtn(
  img: GeneratedImage,
  metadata: { conversationId: string; responseId: string; prompt: string },
  imgEl: HTMLImageElement,
  tile: HTMLDivElement,
  overlay: HTMLDivElement
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

      // Update tile filename to new saved file
      if (result.savedName) {
        // Remove old filename from selected set if selected
        const oldFilename = tile.dataset.filename;
        if (oldFilename && selectedFiles.has(oldFilename)) {
          selectedFiles.delete(oldFilename);
          selectedFiles.add(result.savedName);
        }
        tile.dataset.filename = result.savedName;
        // Update checkbox and delete btn references
        const cb = tile.querySelector<HTMLInputElement>("input[type=checkbox]");
        if (cb) {
          const label = cb.parentElement as HTMLLabelElement;
          label.remove();
          tile.prepend(createCheckbox(result.savedName, tile));
        }
        const delBtn = tile.querySelector<HTMLButtonElement>(".delete-btn");
        if (delBtn) {
          delBtn.remove();
          // Re-insert delete btn
          btn.before(createDeleteBtn(result.savedName, tile));
        }
      }

      // Update tile click handler
      tile.onclick = (ev) => {
        if ((ev.target as HTMLElement).closest(".upscale-btn")) return;
        if ((ev.target as HTMLElement).closest(".delete-btn")) return;
        if ((ev.target as HTMLElement).closest(".tile-checkbox")) return;
        if (selectionMode) {
          toggleTileSelection(tile, tile.dataset.filename!);
          return;
        }
        // Open modal instead of new tab
        openImageModal(result.url, tile.dataset.prompt, tile.dataset.aspectRatio, img.filename);
      };

      // Update overlay with file size
      const sizeMB = (result.bytes / 1024 / 1024).toFixed(1);
      overlay.textContent = `${img.filename} • 2K • ${sizeMB} MB`;

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

// Image modal for single-image view with full prompt and aspect ratio
let modal: HTMLDivElement | null = null;

function openImageModal(
  imageUrl: string,
  prompt?: string,
  aspectRatio?: string,
  filename?: string
): void {
  // Create modal if it doesn't exist
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "image-modal";
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content">
        <button class="modal-close" aria-label="Close">&times;</button>
        <img class="modal-image" src="" alt="">
        <div class="modal-info">
          <div class="modal-prompt"></div>
          <div class="modal-meta"></div>
        </div>
        <a class="modal-open-btn" href="" target="_blank" rel="noopener">Open Full Size</a>
      </div>
    `;
    document.body.appendChild(modal);

    // Close on backdrop click or close button
    modal.querySelector(".modal-backdrop")!.addEventListener("click", closeModal);
    modal.querySelector(".modal-close")!.addEventListener("click", closeModal);

    // Close on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal?.classList.contains("visible")) {
        closeModal();
      }
    });
  }

  // Update modal content
  const imgEl = modal.querySelector(".modal-image") as HTMLImageElement;
  const promptEl = modal.querySelector(".modal-prompt") as HTMLDivElement;
  const metaEl = modal.querySelector(".modal-meta") as HTMLDivElement;
  const openBtn = modal.querySelector(".modal-open-btn") as HTMLAnchorElement;

  imgEl.src = imageUrl;
  imgEl.alt = filename || "Generated image";
  openBtn.href = imageUrl;

  // Show prompt (full text)
  if (prompt) {
    promptEl.textContent = prompt;
    promptEl.style.display = "block";
  } else {
    promptEl.style.display = "none";
  }

  // Show aspect ratio + filename
  const metaParts: string[] = [];
  if (aspectRatio) metaParts.push(aspectRatio);
  if (filename) metaParts.push(filename);
  metaEl.textContent = metaParts.join(" • ");
  metaEl.style.display = metaParts.length > 0 ? "block" : "none";

  // Show modal
  modal.classList.add("visible");
  document.body.style.overflow = "hidden";
}

function closeModal(): void {
  if (modal) {
    modal.classList.remove("visible");
    document.body.style.overflow = "";
  }
}

// Text-only response modal (when Gemini returns text instead of images)
let textModal: HTMLDivElement | null = null;

function openTextModal(text: string, prompt?: string): void {
  if (!textModal) {
    textModal = document.createElement("div");
    textModal.id = "text-modal";
    textModal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content text-modal-content">
        <button class="modal-close" aria-label="Close">&times;</button>
        <div class="text-modal-header">
          <span class="text-modal-icon">💬</span>
          <span class="text-modal-title">Gemini Response</span>
        </div>
        <div class="text-modal-prompt"></div>
        <div class="text-modal-body"></div>
      </div>
    `;
    document.body.appendChild(textModal);

    textModal.querySelector(".modal-backdrop")!.addEventListener("click", closeTextModal);
    textModal.querySelector(".modal-close")!.addEventListener("click", closeTextModal);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && textModal?.classList.contains("visible")) {
        closeTextModal();
      }
    });
  }

  const promptEl = textModal.querySelector(".text-modal-prompt") as HTMLDivElement;
  const bodyEl = textModal.querySelector(".text-modal-body") as HTMLDivElement;

  if (prompt) {
    promptEl.textContent = `Prompt: ${prompt}`;
    promptEl.style.display = "block";
  } else {
    promptEl.style.display = "none";
  }

  bodyEl.textContent = text;

  textModal.classList.add("visible");
  document.body.style.overflow = "hidden";
}

function closeTextModal(): void {
  if (textModal) {
    textModal.classList.remove("visible");
    document.body.style.overflow = "";
  }
}

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 5000);
}
