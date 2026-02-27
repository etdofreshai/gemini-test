/**
 * In-memory store for one-click upscale tokens.
 * 
 * Features:
 * - TTL-based expiration (default 24 hours)
 * - Size cap with LRU eviction
 * - Automatic cleanup of expired entries
 */

import crypto from "crypto";

export interface UpscaleMetadata {
  imageToken: string;
  responseChunkId: string;
  conversationId: string;
  responseId: string;
  prompt: string;
  aspectRatio?: string;
  createdAt: number;
}

interface StoreEntry {
  id: string;
  metadata: UpscaleMetadata;
  expiresAt: number;
  lastAccessed: number;
}

// Configuration
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_ENTRIES = 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

class UpscaleStore {
  private store: Map<string, StoreEntry> = new Map();
  private ttlMs: number;
  private maxEntries: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.startCleanupTimer();
  }

  /**
   * Store upscale metadata and return a unique token ID.
   */
  storeMetadata(metadata: Omit<UpscaleMetadata, "createdAt">): string {
    // Cleanup before adding new entry
    this.cleanup();

    // If at capacity, evict LRU entry
    if (this.store.size >= this.maxEntries) {
      this.evictLRU();
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const entry: StoreEntry = {
      id,
      metadata: {
        ...metadata,
        createdAt: now,
      },
      expiresAt: now + this.ttlMs,
      lastAccessed: now,
    };

    this.store.set(id, entry);
    return id;
  }

  /**
   * Retrieve metadata by token ID. Returns null if not found or expired.
   */
  getMetadata(id: string): UpscaleMetadata | null {
    const entry = this.store.get(id);
    if (!entry) {
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.store.delete(id);
      return null;
    }

    // Update last accessed time for LRU
    entry.lastAccessed = Date.now();
    return entry.metadata;
  }

  /**
   * Delete a token by ID.
   */
  delete(id: string): boolean {
    return this.store.delete(id);
  }

  /**
   * Remove expired entries.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): boolean {
    if (this.store.size === 0) return false;

    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, entry] of this.store.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.store.delete(oldestId);
      return true;
    }
    return false;
  }

  /**
   * Start periodic cleanup timer.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
    
    // Don't prevent the process from exiting
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the cleanup timer (for testing/cleanup).
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get store stats (for monitoring/debugging).
   */
  getStats(): { size: number; maxEntries: number; ttlMs: number } {
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }
}

// Singleton instance
export const upscaleStore = new UpscaleStore();
