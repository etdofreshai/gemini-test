import "dotenv/config";
import { readFile, stat, mkdir } from "fs/promises";
import path from "path";
import { lookup } from "mime-types";
import { loadFromEnv, hasCookies } from "./lib/cookies.js";
import { generateImages, downloadImage } from "./lib/gemini.js";

// Bootstrap cookies from .env
loadFromEnv();

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: node index.js <prompt> [image1] [image2] ...");
    console.log('  node index.js "Create an image of the night sky!"');
    console.log('  node index.js "Make it black and white" photo.jpg');
    console.log('  node index.js "Combine these" img1.png img2.jpg');
    process.exit(0);
  }

  if (!hasCookies()) {
    console.error(
      "Missing cookies. Set GOOGLE_COOKIES in .env (full cookie string from DevTools),\nor set __Secure-1PSID and __Secure-1PSIDTS individually."
    );
    process.exit(1);
  }

  const prompt = args[0];
  const imagePaths = args.slice(1);

  console.log(`Prompt: "${prompt}"`);
  if (imagePaths.length > 0) {
    console.log(`Images: ${imagePaths.join(", ")}`);
  }
  console.log();

  // Validate image paths exist
  for (const imgPath of imagePaths) {
    const resolved = path.resolve(imgPath);
    try {
      await stat(resolved);
    } catch {
      console.error(`File not found: ${resolved}`);
      process.exit(1);
    }
  }

  // Read image files into buffers
  const imageBuffers = [];
  for (const imgPath of imagePaths) {
    const resolved = path.resolve(imgPath);
    const buffer = await readFile(resolved);
    const fileName = path.basename(resolved);
    const mimeType = lookup(resolved) || "image/jpeg";
    imageBuffers.push({ buffer, fileName, mimeType });
  }

  const result = await generateImages(prompt, imageBuffers);

  // Download images to output directory
  const outputDir = path.join(process.cwd(), "output");
  await mkdir(outputDir, { recursive: true });

  for (const img of result.images) {
    const ext = img.mime === "image/jpeg" ? ".jpg" : ".png";
    const outputPath = path.join(outputDir, img.filename || `image${ext}`);
    const dims = img.dimensions
      ? ` (${img.dimensions[0]}x${img.dimensions[1]})`
      : "";
    console.log(`  ${img.filename}${dims} - ${img.mime}`);
    await downloadImage(img.url, outputPath);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
