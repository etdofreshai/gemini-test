import "./style.css";

const app = document.getElementById("app");
if (!app) {
  throw new Error("Missing #app root element");
}

app.innerHTML = `
  <main class="launcher-page">
    <h1>Gemini Tools</h1>
    <p class="launcher-subtitle">Choose a tool to get started.</p>
    <div class="tool-grid">
      <a class="tool-card" href="/image-generator.html">
        <div class="tool-icon">🎨</div>
        <h2>Image Generator</h2>
        <p>Create and manage generated images with upscaling.</p>
      </a>
      <a class="tool-card" href="/file-summarizer.html">
        <div class="tool-icon">📝</div>
        <h2>File Summarizer</h2>
        <p>Upload a file and get a concise summary from Gemini.</p>
      </a>
    </div>
  </main>
`;
