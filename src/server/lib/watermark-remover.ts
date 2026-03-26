import sharp from "sharp";
import { removeWatermarkFromBuffer } from "gemini-watermark-remover/node";

/**
 * Remove the Gemini "✨ Made with Google AI" watermark from an image buffer.
 * Uses reverse alpha blending via gemini-watermark-remover.
 */
export async function removeWatermark(inputBuffer: Buffer): Promise<Buffer> {
  const result = await removeWatermarkFromBuffer(inputBuffer, {
    mimeType: "image/png",
    async decodeImageData(buf: Buffer | Uint8Array | ArrayBuffer) {
      const img = sharp(Buffer.from(buf as ArrayBufferLike)).ensureAlpha();
      const { width, height } = await img.metadata();
      if (!width || !height) throw new Error("Could not read image dimensions");
      const rawData = await img.raw().toBuffer();
      return {
        width,
        height,
        data: new Uint8ClampedArray(rawData.buffer, rawData.byteOffset, rawData.byteLength),
      };
    },
    async encodeImageData(
      imageData: { width: number; height: number; data: Uint8ClampedArray },
    ) {
      const buf = await sharp(Buffer.from(imageData.data.buffer), {
        raw: { width: imageData.width, height: imageData.height, channels: 4 },
      })
        .png()
        .toBuffer();
      return buf;
    },
  });

  if (!result.meta.applied) {
    // No watermark detected, return original
    return Buffer.isBuffer(inputBuffer) ? inputBuffer : Buffer.from(inputBuffer);
  }

  return result.buffer;
}
