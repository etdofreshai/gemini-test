/**
 * Tests for upscale-link caching behaviour.
 *
 * Covers:
 *  - Cache miss / first upscale stores the result
 *  - Cache hit returns the cached result without re-generating
 *  - Expired entries (past TTL) return null
 *  - UpscaleStore class cache lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UpscaleStore } from "../src/server/lib/upscale-store.js";
import type { UpscaleCachedResult } from "../src/server/lib/upscale-store.js";

// Use a short TTL for tests (200 ms)
const TEST_TTL_MS = 200;

function makeMeta() {
  return {
    imageToken: "tok_" + Math.random().toString(36).slice(2),
    responseChunkId: "rc_abc",
    conversationId: "conv_123",
    responseId: "resp_456",
    prompt: "a beautiful sunset",
    aspectRatio: "16:9" as string | undefined,
  };
}

describe("UpscaleStore — caching", () => {
  let store: UpscaleStore;

  beforeEach(() => {
    store = new UpscaleStore(TEST_TTL_MS, 100);
  });

  afterEach(() => {
    store.stopCleanup();
  });

  // ---------------------------------------------------------------
  // Cache miss: first access
  // ---------------------------------------------------------------
  it("getCachedResult returns null when no result has been cached yet", () => {
    const id = store.storeMetadata(makeMeta());

    // No cache stored yet
    expect(store.getCachedResult(id)).toBeNull();
  });

  it("getMetadata still works when no cache is present", () => {
    const meta = makeMeta();
    const id = store.storeMetadata(meta);

    const retrieved = store.getMetadata(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.imageToken).toBe(meta.imageToken);
  });

  // ---------------------------------------------------------------
  // Cache hit: after cacheResult
  // ---------------------------------------------------------------
  it("cacheResult stores and getCachedResult retrieves the result", () => {
    const id = store.storeMetadata(makeMeta());

    const ok = store.cacheResult(id, { url: "/images/abc.png", savedName: "abc.png" });
    expect(ok).toBe(true);

    const cached = store.getCachedResult(id);
    expect(cached).not.toBeNull();
    expect(cached!.url).toBe("/images/abc.png");
    expect(cached!.savedName).toBe("abc.png");
    expect(typeof cached!.cachedAt).toBe("number");
    expect(cached!.cachedAt).toBeGreaterThan(0);
  });

  it("cached result survives multiple reads within TTL", () => {
    const id = store.storeMetadata(makeMeta());
    store.cacheResult(id, { url: "/images/x.png", savedName: "x.png" });

    // Read several times
    for (let i = 0; i < 5; i++) {
      const cached = store.getCachedResult(id);
      expect(cached).not.toBeNull();
      expect(cached!.savedName).toBe("x.png");
    }
  });

  it("cacheResult returns false for unknown ID", () => {
    const ok = store.cacheResult("nonexistent-id", { url: "/images/a.png", savedName: "a.png" });
    expect(ok).toBe(false);
  });

  // ---------------------------------------------------------------
  // Expiry: past TTL
  // ---------------------------------------------------------------
  it("getCachedResult returns null after TTL expires", async () => {
    const id = store.storeMetadata(makeMeta());
    store.cacheResult(id, { url: "/images/y.png", savedName: "y.png" });

    // Confirm it's there
    expect(store.getCachedResult(id)).not.toBeNull();

    // Wait for expiry
    await new Promise((r) => setTimeout(r, TEST_TTL_MS + 50));

    // Should be gone
    expect(store.getCachedResult(id)).toBeNull();
  });

  it("getMetadata returns null after TTL expires", async () => {
    const id = store.storeMetadata(makeMeta());

    expect(store.getMetadata(id)).not.toBeNull();

    await new Promise((r) => setTimeout(r, TEST_TTL_MS + 50));

    expect(store.getMetadata(id)).toBeNull();
  });

  it("cacheResult returns false for expired entry", async () => {
    const id = store.storeMetadata(makeMeta());

    await new Promise((r) => setTimeout(r, TEST_TTL_MS + 50));

    const ok = store.cacheResult(id, { url: "/images/z.png", savedName: "z.png" });
    expect(ok).toBe(false);
  });

  // ---------------------------------------------------------------
  // Cleanup removes cached entries too
  // ---------------------------------------------------------------
  it("cleanup removes expired entries with cached results", async () => {
    const id = store.storeMetadata(makeMeta());
    store.cacheResult(id, { url: "/images/c.png", savedName: "c.png" });

    await new Promise((r) => setTimeout(r, TEST_TTL_MS + 50));

    const removed = store.cleanup();
    expect(removed).toBeGreaterThanOrEqual(1);

    expect(store.getCachedResult(id)).toBeNull();
    expect(store.getMetadata(id)).toBeNull();
  });

  // ---------------------------------------------------------------
  // Multiple entries
  // ---------------------------------------------------------------
  it("caching works independently for multiple entries", () => {
    const id1 = store.storeMetadata(makeMeta());
    const id2 = store.storeMetadata(makeMeta());

    store.cacheResult(id1, { url: "/images/one.png", savedName: "one.png" });
    // id2 is NOT cached

    expect(store.getCachedResult(id1)).not.toBeNull();
    expect(store.getCachedResult(id1)!.savedName).toBe("one.png");
    expect(store.getCachedResult(id2)).toBeNull();
  });

  // ---------------------------------------------------------------
  // Stats still work
  // ---------------------------------------------------------------
  it("getStats reflects store size correctly", () => {
    store.storeMetadata(makeMeta());
    store.storeMetadata(makeMeta());

    const stats = store.getStats();
    expect(stats.size).toBe(2);
    expect(stats.ttlMs).toBe(TEST_TTL_MS);
    expect(stats.maxEntries).toBe(100);
  });
});
