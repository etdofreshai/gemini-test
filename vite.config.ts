import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: "src/client/index.html",
        imageGenerator: "src/client/image-generator.html",
        fileSummarizer: "src/client/file-summarizer.html",
        watermarkRemover: "src/client/watermark-remover.html",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api/": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/auth/": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/tmp/": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
