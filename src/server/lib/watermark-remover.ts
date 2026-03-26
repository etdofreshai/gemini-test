import sharp from "sharp";

/**
 * Gemini sparkle watermark remover.
 *
 * Uses a pre-derived alpha map (from a solid-color Gemini image, March 2026)
 * to locate watermark pixels, then inpaints them from neighboring clean pixels.
 *
 * Alpha map: 30×30 greyscale PNG covering the sparkle region.
 * Reference image: 512×512. Watermark at (471,471)→(496,496), margin ~16px from edges.
 * The position/size scales proportionally for other image dimensions.
 */

// Alpha map PNG (30×30 greyscale) — derived from 512×512 solid red Gemini output
const ALPHA_MAP_BASE64 = `iVBORw0KGgoAAAANSUhEUgAAAB4AAAAeCAIAAAC0Ujn1AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAC7UlEQVR4nI1W3U7rPBD0b9qCBBK9gXJRifepyid6h5Qi+gh1kUJFQmJb9LGPPg/dbuPAOXNRpY49np21dyNEBmMM/ysT6JVSCn/xoLW2CZeXlxcXF1prKaW19vr6OmcW1lrxK0BqrTXGTCYTY4y1tigKjGCnoijEv2AymeSRKaVGoxG2Aa9KIOHfU7XWg6SGmfNfAiwajUbQCDoppUkYj8cwUCn1HWBPozyay+Gcq6oKz5LBGEP54OMD6ghaa0ra1dVVjLFt2/l8ju3xluaAgXwYFCdolL9er9dd13nvy7KEFC6TL59Op1LK6XQ6wKgSsD+0zOdzSK7r+nA4zGYziikXiCVnNmCGTYy92e/v7/URTdM4534Muac/Fy6Ya5vN5vPzk6jbtiVbsCTP0+mE0JM6HhXaY7lchhCIF/Lbtg0hLJfLv6gGEV0KpRQ9v7y8gLdNqM8RQthsNoMRn4Zwf/jFub293W633IdBNE1TVdX9/T0nPPOHX5nZbFaWJcR+fHxAbC6Zj8QY1+s15Wzgijw9Pe12uxBC13XgHVQ6uFnXdTFG59xqtTpjhxuPj4/b7RbUP/Fyas7eNE0IoaoqKjLf1vMM3NzcvL6+xhh/1xtCIOoYY1mWKADDWeVn4+Hhoaoq7z2tHzwk3nvn3N3d3W+HBNQmlXYap8NX1/V+v+cW42jTxcnxv915fZHs72KxiDHuE7ghX19fi8WCitGPl56KkU7nGvml2c/Pz957UOPXe4/LopQCNWc7dRWZYXJsBVQAnHPcjbe3N9IkhOBtsF9LByHIsnSPUFTbto0x4vrRNDrFVIhOcQxSm2NbGo/HaAXe+6ZpkDo0WbzK7e3z6oR8D8SLbnA4HM5CPkbGS8WpzFJ5oii01iSZTBdC7HY7agI8db2i0VfNo5NsGd9glYC8UffK0W9d9MWllCqKAiP0sQJnSdRZohKstafO0hPOw8y/KECNs49lXFrvpA6Ae00u4RlKe/2II8+tEOIPfMc+H8zpmV8AAAAASUVORK5CYII=`;

// Reference dimensions
const REF_SIZE = 512;
const MAP_W = 30; // alpha map width (26px watermark + 2px padding each side)
const MAP_H = 30;
const WM_START_X = 469; // top-left of alpha map region in reference image
const WM_START_Y = 469;
const WM_SIZE = 26; // actual watermark size (without padding)
const WM_MARGIN = 16; // margin from right/bottom edge at reference size

// Alpha threshold: pixels with alpha map value above this are considered watermark
const ALPHA_THRESHOLD = 5;

let cachedAlpha: Buffer | null = null;

async function getAlphaMap(): Promise<Buffer> {
  if (cachedAlpha) return cachedAlpha;
  const buf = Buffer.from(ALPHA_MAP_BASE64, "base64");
  const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  cachedAlpha = Buffer.from(data);
  return cachedAlpha;
}

/**
 * Remove the Gemini sparkle watermark via alpha-map-guided inpainting.
 *
 * 1. Scale the alpha map to match the input image dimensions.
 * 2. Build a binary mask of watermark pixels.
 * 3. Replace each masked pixel with the average of its nearest unmasked neighbors.
 */
export async function removeWatermark(inputBuffer: Buffer): Promise<Buffer> {
  const meta = await sharp(inputBuffer).metadata();
  const w = meta.width!;
  const h = meta.height!;

  const alphaRaw = await getAlphaMap();

  // Scale factor
  const scale = Math.min(w, h) / REF_SIZE;
  const sW = Math.round(MAP_W * scale);
  const sH = Math.round(MAP_H * scale);
  const sX = Math.round(WM_START_X * scale);
  const sY = Math.round(WM_START_Y * scale);

  // Resize alpha map
  const scaledAlpha = await sharp(alphaRaw, {
    raw: { width: MAP_W, height: MAP_H, channels: 1 },
  })
    .resize(sW, sH, { kernel: "lanczos3" })
    .raw()
    .toBuffer();

  // Get image pixels
  const { data: imgData, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ch = info.channels; // 4 (RGBA)
  const pixels = Buffer.from(imgData);

  // Build mask
  const mask = new Uint8Array(w * h);
  for (let dy = 0; dy < sH; dy++) {
    for (let dx = 0; dx < sW; dx++) {
      const imgX = sX + dx;
      const imgY = sY + dy;
      if (imgX >= w || imgY >= h) continue;
      if (scaledAlpha[dy * sW + dx] > ALPHA_THRESHOLD) {
        mask[imgY * w + imgX] = 1;
      }
    }
  }

  // Inpaint: replace each masked pixel with average of nearest unmasked neighbors
  for (let dy = 0; dy < sH; dy++) {
    for (let dx = 0; dx < sW; dx++) {
      const imgX = sX + dx;
      const imgY = sY + dy;
      if (imgX >= w || imgY >= h) continue;
      if (!mask[imgY * w + imgX]) continue;

      let sumR = 0, sumG = 0, sumB = 0, count = 0;

      // Search outward in expanding rings for clean pixels
      for (let r = 1; r <= 20 && count < 8; r++) {
        for (let ddy = -r; ddy <= r; ddy++) {
          for (let ddx = -r; ddx <= r; ddx++) {
            // Only ring pixels
            if (Math.abs(ddx) !== r && Math.abs(ddy) !== r) continue;
            const nx = imgX + ddx;
            const ny = imgY + ddy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (mask[ny * w + nx]) continue;
            const nIdx = (ny * w + nx) * ch;
            sumR += imgData[nIdx];
            sumG += imgData[nIdx + 1];
            sumB += imgData[nIdx + 2];
            count++;
          }
        }
      }

      if (count > 0) {
        const pIdx = (imgY * w + imgX) * ch;
        pixels[pIdx] = Math.round(sumR / count);
        pixels[pIdx + 1] = Math.round(sumG / count);
        pixels[pIdx + 2] = Math.round(sumB / count);
      }
    }
  }

  return sharp(pixels, { raw: { width: w, height: h, channels: ch } })
    .png()
    .toBuffer();
}
