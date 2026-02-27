/**
 * Persistent metadata store for generated images.
 * Stores prompt, aspect ratio, and other metadata alongside images.
 */

import fs from "fs";
import path from "path";

export interface ImageMetadata {
  prompt: string;
  aspectRatio?: string;
  createdAt: number;
}

const METADATA_FILE = ".image-metadata.json";

function getMetadataPath(imagesDir: string): string {
  return path.join(imagesDir, METADATA_FILE);
}

class ImageMetaStore {
  private imagesDir: string;
  private cache: Map<string, ImageMetadata> | null = null;

  constructor(imagesDir: string) {
    this.imagesDir = imagesDir;
  }

  private load(): Map<string, ImageMetadata> {
    if (this.cache) return this.cache;

    const metaPath = getMetadataPath(this.imagesDir);
    const map = new Map<string, ImageMetadata>();

    try {
      if (fs.existsSync(metaPath)) {
        const data = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        for (const [key, value] of Object.entries(data)) {
          map.set(key, value as ImageMetadata);
        }
      }
    } catch (err) {
      console.error("Failed to load image metadata:", err);
    }

    this.cache = map;
    return map;
  }

  private save(): void {
    if (!this.cache) return;

    const metaPath = getMetadataPath(this.imagesDir);
    const obj: Record<string, ImageMetadata> = {};
    for (const [key, value] of this.cache.entries()) {
      obj[key] = value;
    }

    try {
      fs.writeFileSync(metaPath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save image metadata:", err);
    }
  }

  /**
   * Store metadata for an image file.
   */
  set(filename: string, metadata: ImageMetadata): void {
    const map = this.load();
    map.set(filename, metadata);
    this.save();
  }

  /**
   * Get metadata for an image file. Returns null if not found.
   */
  get(filename: string): ImageMetadata | null {
    const map = this.load();
    return map.get(filename) || null;
  }

  /**
   * Delete metadata for an image file.
   */
  delete(filename: string): boolean {
    const map = this.load();
    const existed = map.delete(filename);
    if (existed) {
      this.save();
    }
    return existed;
  }

  /**
   * Delete metadata for multiple files.
   */
  deleteMany(filenames: string[]): number {
    const map = this.load();
    let deleted = 0;
    for (const f of filenames) {
      if (map.delete(f)) deleted++;
    }
    if (deleted > 0) {
      this.save();
    }
    return deleted;
  }

  /**
   * Get all metadata as a record.
   */
  getAll(): Record<string, ImageMetadata> {
    const map = this.load();
    const obj: Record<string, ImageMetadata> = {};
    for (const [key, value] of map.entries()) {
      obj[key] = value;
    }
    return obj;
  }

  /**
   * Clear the in-memory cache (useful when imagesDir changes).
   */
  clearCache(): void {
    this.cache = null;
  }
}

let storeInstance: ImageMetaStore | null = null;

/**
 * Get the singleton image metadata store for the given images directory.
 */
export function getImageMetaStore(imagesDir: string): ImageMetaStore {
  if (!storeInstance) {
    storeInstance = new ImageMetaStore(imagesDir);
  } else {
    // If directory changed, clear cache
    storeInstance.clearCache();
  }
  return storeInstance;
}
