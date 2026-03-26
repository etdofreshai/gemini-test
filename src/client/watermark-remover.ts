import "./style.css";

const app = document.getElementById("app")!;
app.innerHTML = `
  <main class="wm-page">
    <div class="wm-header">
      <a href="/" class="top-nav-link">← Back</a>
      <h1>✨ Watermark Remover</h1>
      <p>Remove the Gemini "Made with Google AI" watermark from images.</p>
    </div>

    <div class="wm-drop-zone" id="drop-zone">
      <div class="wm-drop-icon">📁</div>
      <p>Drag & drop an image here, or click to select</p>
      <input type="file" id="file-input" accept="image/png,image/jpeg,image/webp" hidden>
    </div>

    <div class="wm-comparison" id="comparison" style="display:none">
      <div class="wm-col">
        <h3>Before</h3>
        <img id="before-img">
      </div>
      <div class="wm-col">
        <h3>After</h3>
        <div id="after-container">
          <div class="spinner" id="after-spinner"></div>
          <img id="after-img" style="display:none">
        </div>
      </div>
    </div>

    <div id="wm-status" class="wm-status"></div>
    <div id="wm-actions" style="display:none">
      <a id="download-link" class="primary-btn" download="cleaned.png">Download Cleaned Image</a>
      <button class="secondary-btn" id="reset-btn">Try Another</button>
    </div>
  </main>
`;

const dropZone = document.getElementById("drop-zone")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const comparison = document.getElementById("comparison")!;
const beforeImg = document.getElementById("before-img") as HTMLImageElement;
const afterImg = document.getElementById("after-img") as HTMLImageElement;
const afterSpinner = document.getElementById("after-spinner")!;
const status = document.getElementById("wm-status")!;
const actions = document.getElementById("wm-actions")!;
const downloadLink = document.getElementById("download-link") as HTMLAnchorElement;
const resetBtn = document.getElementById("reset-btn")!;

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files[0];
  if (file) processFile(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) processFile(fileInput.files[0]);
});
resetBtn.addEventListener("click", () => {
  comparison.style.display = "none";
  actions.style.display = "none";
  status.textContent = "";
  dropZone.style.display = "";
  afterImg.style.display = "none";
  afterSpinner.style.display = "";
});

async function processFile(file: File) {
  // Show before
  const objectUrl = URL.createObjectURL(file);
  beforeImg.src = objectUrl;
  dropZone.style.display = "none";
  comparison.style.display = "";
  afterImg.style.display = "none";
  afterSpinner.style.display = "";
  actions.style.display = "none";
  status.textContent = "Processing...";

  try {
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/remove-watermark", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Failed");
    }
    const blob = await res.blob();
    const cleanedUrl = URL.createObjectURL(blob);
    afterImg.src = cleanedUrl;
    afterImg.style.display = "";
    afterSpinner.style.display = "none";
    downloadLink.href = cleanedUrl;
    actions.style.display = "";
    status.textContent = "Done!";
  } catch (err: any) {
    afterSpinner.style.display = "none";
    status.textContent = `Error: ${err.message}`;
  }
}
