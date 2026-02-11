import "dotenv/config";
import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { lookup } from "mime-types";

const GEMINI_URL = "https://gemini.google.com";

// Build the cookie string from env vars
function getCookies() {
  // Option 1: Full cookie string (copy entire Cookie header from DevTools)
  if (process.env.GOOGLE_COOKIES) {
    return process.env.GOOGLE_COOKIES;
  }
  // Option 2: Individual cookie values
  const psid = process.env["__Secure-1PSID"];
  const psidts = process.env["__Secure-1PSIDTS"];
  if (!psid || !psidts) {
    console.error(
      "Missing cookies. Set GOOGLE_COOKIES in .env (full cookie string from DevTools),\nor set __Secure-1PSID and __Secure-1PSIDTS individually."
    );
    process.exit(1);
  }
  return `__Secure-1PSID=${psid}; __Secure-1PSIDTS=${psidts}`;
}

// Fetch the Gemini page and extract session tokens from the HTML
async function getSessionTokens(cookies) {
  console.log("Fetching Gemini page to extract session tokens...");
  const res = await fetch(`${GEMINI_URL}/app`, {
    headers: {
      Cookie: cookies,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    redirect: "manual",
  });

  if (res.status >= 300 && res.status < 400) {
    console.error(
      "Got redirect - your cookies may be expired. Re-copy them from your browser."
    );
    process.exit(1);
  }

  const html = await res.text();

  // Extract SNlM0e (the "at" CSRF token)
  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (!atMatch) {
    console.error("Could not extract CSRF token (SNlM0e) from page.");
    process.exit(1);
  }
  const at = atMatch[1];

  // Extract cfb2h (the "bl" build version)
  const blMatch = html.match(/"cfb2h":"([^"]+)"/);
  if (!blMatch) {
    console.error("Could not extract build version (cfb2h) from page.");
    process.exit(1);
  }
  const bl = blMatch[1];

  // Extract FdrFJe (the "f.sid" session ID)
  const sidMatch = html.match(/"FdrFJe":"([^"]+)"/);
  if (!sidMatch) {
    console.error("Could not extract session ID (FdrFJe) from page.");
    process.exit(1);
  }
  const fSid = sidMatch[1];

  // Extract qKIAYe (Push-ID / feed channel for uploads)
  const pushIdMatch = html.match(/"qKIAYe":"([^"]+)"/);
  const pushId = pushIdMatch ? pushIdMatch[1] : null;

  // Extract Ylro7b (X-Client-Pctx for uploads)
  const pctxMatch = html.match(/"Ylro7b":"([^"]+)"/);
  const clientPctx = pctxMatch ? pctxMatch[1] : null;

  console.log(`  CSRF token: ${at.slice(0, 20)}...`);
  console.log(`  Build: ${bl}`);
  console.log(`  Session ID: ${fSid}`);
  if (pushId) console.log(`  Push-ID: ${pushId}`);

  return { at, bl, fSid, pushId, clientPctx };
}

// Upload an image via Google's resumable upload protocol (2-phase)
async function uploadImage(filePath, cookies, pushId, clientPctx) {
  const fileName = path.basename(filePath);
  const fileBuffer = await readFile(filePath);
  const fileSize = fileBuffer.length;
  const mimeType = lookup(filePath) || "image/jpeg";

  console.log(`  Uploading ${fileName} (${(fileSize / 1024).toFixed(1)} KB, ${mimeType})...`);

  // Phase 1: Initiate upload
  const initHeaders = {
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(fileSize),
    "X-Tenant-Id": "bard-storage",
    "Push-ID": pushId,
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Cookie: cookies,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    Origin: "https://gemini.google.com",
    Referer: "https://gemini.google.com/",
  };
  if (clientPctx) initHeaders["X-Client-Pctx"] = clientPctx;

  const initRes = await fetch("https://push.clients6.google.com/upload/", {
    method: "POST",
    headers: initHeaders,
    body: `File name: ${fileName}`,
  });

  if (!initRes.ok) {
    const errBody = await initRes.text();
    throw new Error(
      `Upload init failed: HTTP ${initRes.status}\n${errBody.slice(0, 500)}`
    );
  }

  const uploadUrl = initRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("No upload URL returned from init phase");
  }

  // Phase 2: Upload binary data
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "X-Tenant-Id": "bard-storage",
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      Cookie: cookies,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      Origin: "https://gemini.google.com",
      Referer: "https://gemini.google.com/",
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload finalize failed: HTTP ${uploadRes.status}`);
  }

  const uploadPath = await uploadRes.text();
  console.log(`  Uploaded -> ${uploadPath.slice(0, 60)}...`);

  return { uploadPath: uploadPath.trim(), fileName, mimeType };
}

// Build the f.req payload for StreamGenerate
function buildRequestPayload(prompt, at, clientUuid, attachments = []) {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1000000;

  // The inner payload array - matches the exact structure from the HAR
  const inner = new Array(69).fill(null);
  // Build attachments array if images were uploaded
  const attachmentData =
    attachments.length > 0
      ? attachments.map((a) => [[a.uploadPath, 1, null, a.mimeType], a.fileName])
      : null;

  inner[0] = [prompt, 0, null, attachmentData, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[3] = at; // SNlM0e token doubles as the request auth token
  inner[4] = ""; // Request hash - can be empty for new conversations
  // inner[5] = null
  inner[6] = [1];
  inner[7] = 1;
  // inner[8..9] = null
  inner[10] = 1;
  inner[11] = 0;
  // inner[12..16] = null
  inner[17] = [[0]];
  inner[18] = 0;
  // inner[19..26] = null
  inner[27] = 1;
  // inner[28..29] = null
  inner[30] = [4];
  // inner[31..40] = null
  inner[41] = [1];
  // inner[42..48] = null
  inner[49] = 14;
  // inner[50..52] = null
  inner[53] = 0;
  // inner[54..58] = null
  inner[59] = clientUuid;
  // inner[60] = null
  inner[61] = [];
  // inner[62..65] = null
  inner[66] = [seconds, nanos];
  inner[67] = 0;
  inner[68] = 2;

  return JSON.stringify([null, JSON.stringify(inner)]);
}

// Parse the streaming response to extract image URLs
function parseStreamResponse(responseText) {
  // Strip the anti-XSSI prefix
  const cleaned = responseText.replace(/^\)\]\}'\s*\n/, "");
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);

  const images = [];
  let conversationId = null;
  let responseId = null;
  let modelName = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip length lines (pure numbers)
    if (/^\d+$/.test(line)) continue;

    let outerChunk;
    try {
      outerChunk = JSON.parse(line);
    } catch {
      continue;
    }

    // Handle end-of-stream markers
    if (
      Array.isArray(outerChunk) &&
      outerChunk.length > 0 &&
      Array.isArray(outerChunk[0])
    ) {
      const tag = outerChunk[0][0];
      if (tag === "di" || tag === "e" || tag === "af.httprm") continue;
    }

    // Content chunks: [["wrb.fr", null, "<inner_json>"]]
    if (
      !Array.isArray(outerChunk) ||
      !outerChunk[0] ||
      outerChunk[0][0] !== "wrb.fr"
    ) {
      continue;
    }

    const innerStr = outerChunk[0][2];
    if (!innerStr) continue;

    let inner;
    try {
      inner = JSON.parse(innerStr);
    } catch {
      continue;
    }

    // Extract conversation/response IDs
    if (Array.isArray(inner[1]) && inner[1].length >= 2) {
      conversationId = inner[1][0] || conversationId;
      responseId = inner[1][1] || responseId;
    }

    // Extract model name
    if (inner[42] && typeof inner[42] === "string") {
      modelName = inner[42];
    }

    // Log thinking/status messages
    if (inner[2] && typeof inner[2] === "object") {
      const meta = inner[2];
      // Thinking status
      if (meta["7"]) {
        const thinkingData = meta["7"];
        if (Array.isArray(thinkingData[5]) && thinkingData[5][0]) {
          console.log(`  Thinking: ${thinkingData[5][0]}`);
        }
        // Tool loading status
        if (Array.isArray(thinkingData[1]) && thinkingData[1][1]) {
          const toolInfo = thinkingData[1][1];
          if (Array.isArray(toolInfo) && toolInfo[2]) {
            console.log(`  Status: ${toolInfo[2]}`);
          }
        }
      }
    }

    // Extract images from candidates
    if (!Array.isArray(inner[4])) continue;

    for (const candidate of inner[4]) {
      if (!Array.isArray(candidate) || !candidate[12]) continue;

      const imageContainer = candidate[12];

      // Collect image group arrays from both response formats
      const allImageGroups = [];

      // Format 1: Text-only generation - inner[4][0][12][7][0][*]
      if (Array.isArray(imageContainer[7]?.[0])) {
        allImageGroups.push(...imageContainer[7][0]);
      }

      // Format 2: Image edit - inner[4][0][12][0]["8"][0][*]
      // [12] is a list with one dict element; output images at key "8"
      if (Array.isArray(imageContainer) && imageContainer[0]?.["8"]) {
        const editImages = imageContainer[0]["8"];
        if (Array.isArray(editImages[0])) {
          allImageGroups.push(...editImages[0]);
        }
      }

      for (const group of allImageGroups) {
        if (!Array.isArray(group) || !Array.isArray(group[0])) continue;

        // Each group has image variants at indices [3] and [6]
        const variants = [group[0][3], group[0][6]].filter(Boolean);

        for (const variant of variants) {
          if (!Array.isArray(variant) || !variant[3]) continue;
          const url = variant[3];
          const filename = variant[2] || "image";
          const mime = variant[11] || "image/png";
          const dimensions = variant[15]; // [width, height, size]

          // Deduplicate by URL
          if (!images.find((img) => img.url === url)) {
            images.push({ url, filename, mime, dimensions });
          }
        }
      }
    }
  }

  return { images, conversationId, responseId, modelName };
}

// Download an image, manually following redirects to preserve headers across domains
async function downloadImage(url, outputPath, cookies) {
  console.log(`  Downloading ${path.basename(outputPath)}...`);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    Referer: "https://gemini.google.com/",
    Cookie: cookies,
  };

  let currentUrl = url;
  let res;

  // Manually follow up to 5 redirects, preserving headers across domains
  for (let i = 0; i < 5; i++) {
    res = await fetch(currentUrl, { headers, redirect: "manual" });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      currentUrl = location;
      console.log(`    Redirect ${i + 1} -> ${new URL(currentUrl).hostname}...`);
      continue;
    }
    break;
  }

  if (!res.ok) {
    console.error(`  Failed to download: HTTP ${res.status}`);
    return;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buffer);
  console.log(`  Saved ${outputPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: node index.js <prompt> [image1] [image2] ...");
    console.log('  node index.js "Create an image of the night sky!"');
    console.log('  node index.js "Make it black and white" photo.jpg');
    console.log('  node index.js "Combine these" img1.png img2.jpg');
    process.exit(0);
  }

  const prompt = args[0];
  const imagePaths = args.slice(1);

  console.log(`Prompt: "${prompt}"`);
  if (imagePaths.length > 0) {
    console.log(`Images: ${imagePaths.join(", ")}`);
  }
  console.log();

  const cookies = getCookies();
  const { at, bl, fSid, pushId, clientPctx } = await getSessionTokens(cookies);
  const clientUuid = randomUUID().toUpperCase();
  const reqId = Math.floor(100000 + Math.random() * 900000) * 100;

  // Upload input images if provided
  const attachments = [];
  for (const imgPath of imagePaths) {
    const resolved = path.resolve(imgPath);
    try {
      await stat(resolved);
    } catch {
      console.error(`File not found: ${resolved}`);
      process.exit(1);
    }
    const uploaded = await uploadImage(resolved, cookies, pushId, clientPctx);
    attachments.push(uploaded);
  }

  // Build the StreamGenerate request
  const url = new URL(
    `${GEMINI_URL}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
  );
  url.searchParams.set("bl", bl);
  url.searchParams.set("f.sid", fSid);
  url.searchParams.set("hl", "en");
  url.searchParams.set("_reqid", String(reqId));
  url.searchParams.set("rt", "c");

  const modelId = "e051ce1aa80aa576"; // Gemini model ID from the HAR

  const body = new URLSearchParams();
  body.set("f.req", buildRequestPayload(prompt, at, clientUuid, attachments));
  body.set("at", at);

  console.log("\nSending generation request...");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Same-Domain": "1",
      "x-goog-ext-73010989-jspb": "[0]",
      "x-goog-ext-525001261-jspb": JSON.stringify([
        1, null, null, null, modelId, null, null, 0, [4], null, null, 2,
      ]),
      "x-goog-ext-525005358-jspb": JSON.stringify([clientUuid, 1]),
      Cookie: cookies,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      Referer: "https://gemini.google.com/",
      Origin: "https://gemini.google.com",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    console.error(`Request failed: HTTP ${res.status}`);
    const text = await res.text();
    console.error(text.slice(0, 500));
    process.exit(1);
  }

  console.log("Streaming response received. Parsing...\n");
  const responseText = await res.text();

  const { images, conversationId, responseId, modelName } =
    parseStreamResponse(responseText);

  console.log(`\nModel: ${modelName || "unknown"}`);
  console.log(`Conversation: ${conversationId}`);
  console.log(`Response: ${responseId}`);
  console.log(`Images found: ${images.length}\n`);

  if (images.length === 0) {
    console.log("No images found in the response.");
    console.log("Raw response (first 2000 chars):");
    console.log(responseText.slice(0, 2000));
    process.exit(1);
  }

  // Download images
  const outputDir = path.join(process.cwd(), "output");
  await mkdir(outputDir, { recursive: true });

  for (const img of images) {
    const ext = img.mime === "image/jpeg" ? ".jpg" : ".png";
    const outputPath = path.join(outputDir, img.filename || `image${ext}`);
    const dims = img.dimensions
      ? ` (${img.dimensions[0]}x${img.dimensions[1]})`
      : "";
    console.log(`  ${img.filename}${dims} - ${img.mime}`);
    await downloadImage(img.url, outputPath, cookies);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
