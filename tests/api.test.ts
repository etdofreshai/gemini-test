/**
 * Basic API tests for Gemini Image Generation Server
 * 
 * Run with: npm test
 * 
 * These tests verify API endpoint behavior without requiring authentication.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "child_process";
import http from "http";

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;

function request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const req = http.request(
      `${BASE_URL}${path}`,
      {
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, data });
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("Gemini Image API", () => {
  let server: ChildProcess;
  let serverReady = false;

  beforeAll(async () => {
    // Start the server
    server = spawn("node", ["dist/server/index.js"], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    server.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
    server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));

    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
      try {
        await request("GET", "/api/health");
        serverReady = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    
    if (!serverReady) {
      throw new Error("Server failed to start");
    }
  }, 10000);

  afterAll(() => {
    server?.kill();
  });

  describe("Health Endpoint", () => {
    it("GET /api/health returns ok status", async () => {
      const res = await request("GET", "/api/health");
      expect(res.status).toBe(200);
      expect((res.data as any).status).toBe("ok");
      expect((res.data as any).timestamp).toBeDefined();
      expect(typeof (res.data as any).authenticated).toBe("boolean");
    });
  });

  describe("Auth Endpoints", () => {
    it("GET /api/status returns authenticated boolean", async () => {
      const res = await request("GET", "/api/status");
      expect(res.status).toBe(200);
      expect(typeof (res.data as any).authenticated).toBe("boolean");
    });

    it("GET /api/login returns redirect path", async () => {
      const res = await request("GET", "/api/login");
      expect(res.status).toBe(200);
      expect((res.data as any).redirect).toBe("/auth/remote-login");
    });
  });

  describe("Image Generation", () => {
    it("POST /api/generate rejects missing prompt", async () => {
      const res = await request("POST", "/api/generate", {});
      expect(res.status).toBe(400);
      expect((res.data as any).error).toContain("prompt");
    });

    it("POST /api/generate rejects empty prompt", async () => {
      const res = await request("POST", "/api/generate", { prompt: "   " });
      expect(res.status).toBe(400);
      expect((res.data as any).error).toContain("empty");
    });

    it("POST /api/generate rejects invalid aspect ratio", async () => {
      const res = await request("POST", "/api/generate", { prompt: "test", aspectRatio: "invalid" });
      expect(res.status).toBe(400);
      expect((res.data as any).error).toContain("aspect ratio");
    });

    it("POST /api/generate rejects prompt exceeding max length", async () => {
      const longPrompt = "a".repeat(5000);
      const res = await request("POST", "/api/generate", { prompt: longPrompt });
      expect(res.status).toBe(400);
      expect((res.data as any).error).toContain("maximum length");
    });
  });

  describe("Upscale Endpoint", () => {
    it("POST /api/upscale rejects missing fields", async () => {
      const res = await request("POST", "/api/upscale", {});
      expect(res.status).toBe(400);
      expect((res.data as any).error).toContain("Missing or invalid fields");
    });

    it("POST /api/upscale rejects partial fields", async () => {
      const res = await request("POST", "/api/upscale", { imageToken: "abc" });
      expect(res.status).toBe(400);
      expect((res.data as any).error).toContain("responseChunkId");
    });
  });

  describe("Image List", () => {
    it("GET /api/images returns array", async () => {
      const res = await request("GET", "/api/images");
      expect(res.status).toBe(200);
      expect(Array.isArray((res.data as any).images)).toBe(true);
    });

    it("DELETE /api/images rejects missing filenames", async () => {
      const res = await request("DELETE", "/api/images", {});
      expect(res.status).toBe(400);
      expect((res.data as any).error).toContain("filenames");
    });
  });
});
