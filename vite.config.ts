import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
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
