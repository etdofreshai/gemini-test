import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { lookup } from "mime-types";
import {
  getCookieString,
  refreshCookiesFromResponse,
} from "./cookies.js";

const GEMINI_URL = "https://gemini.google.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

// Fetch the Gemini page and extract session tokens from the HTML
export async function getSessionTokens() {
  const cookies = getCookieString();
  console.log("Fetching Gemini page to extract session tokens...");
  const res = await fetch(`${GEMINI_URL}/app`, {
    headers: { Cookie: cookies, "User-Agent": USER_AGENT },
    redirect: "manual",
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      "Got redirect - your cookies may be expired. Re-copy them from your browser."
    );
  }

  await refreshCookiesFromResponse(res);

  const html = await res.text();

  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (!atMatch) {
    throw new Error("Could not extract CSRF token (SNlM0e) from page.");
  }
  const at = atMatch[1];

  const blMatch = html.match(/"cfb2h":"([^"]+)"/);
  if (!blMatch) {
    throw new Error("Could not extract build version (cfb2h) from page.");
  }
  const bl = blMatch[1];

  const sidMatch = html.match(/"FdrFJe":"([^"]+)"/);
  if (!sidMatch) {
    throw new Error("Could not extract session ID (FdrFJe) from page.");
  }
  const fSid = sidMatch[1];

  const pushIdMatch = html.match(/"qKIAYe":"([^"]+)"/);
  const pushId = pushIdMatch ? pushIdMatch[1] : null;

  const pctxMatch = html.match(/"Ylro7b":"([^"]+)"/);
  const clientPctx = pctxMatch ? pctxMatch[1] : null;

  console.log(`  CSRF token: ${at.slice(0, 20)}...`);
  console.log(`  Build: ${bl}`);
  console.log(`  Session ID: ${fSid}`);
  if (pushId) console.log(`  Push-ID: ${pushId}`);

  return { at, bl, fSid, pushId, clientPctx };
}

// Upload an image from a file path
export async function uploadImage(filePath, pushId, clientPctx) {
  const fileName = path.basename(filePath);
  const fileBuffer = await readFile(filePath);
  const mimeType = lookup(filePath) || "image/jpeg";
  return uploadImageBuffer(fileBuffer, fileName, mimeType, pushId, clientPctx);
}

// Upload an image from an in-memory buffer
export async function uploadImageBuffer(
  buffer,
  fileName,
  mimeType,
  pushId,
  clientPctx
) {
  const cookies = getCookieString();
  const fileSize = buffer.length;

  console.log(
    `  Uploading ${fileName} (${(fileSize / 1024).toFixed(1)} KB, ${mimeType})...`
  );

  // Phase 1: Initiate upload
  const initHeaders = {
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(fileSize),
    "X-Tenant-Id": "bard-storage",
    "Push-ID": pushId,
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Cookie: cookies,
    "User-Agent": USER_AGENT,
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
      "User-Agent": USER_AGENT,
      Origin: "https://gemini.google.com",
      Referer: "https://gemini.google.com/",
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload finalize failed: HTTP ${uploadRes.status}`);
  }

  const uploadPath = await uploadRes.text();
  console.log(`  Uploaded -> ${uploadPath.slice(0, 60)}...`);

  return { uploadPath: uploadPath.trim(), fileName, mimeType };
}

// Build the f.req payload for StreamGenerate
export function buildRequestPayload(prompt, at, clientUuid, attachments = []) {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1000000;

  const inner = new Array(69).fill(null);
  const attachmentData =
    attachments.length > 0
      ? attachments.map((a) => [
          [a.uploadPath, 1, null, a.mimeType],
          a.fileName,
        ])
      : null;

  inner[0] = [prompt, 0, null, attachmentData, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[3] = at;
  inner[4] = "";
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[49] = 14;
  inner[53] = 0;
  inner[59] = clientUuid;
  inner[61] = [];
  inner[66] = [seconds, nanos];
  inner[67] = 0;
  inner[68] = 2;

  return JSON.stringify([null, JSON.stringify(inner)]);
}

// Parse the streaming response to extract image URLs
export function parseStreamResponse(responseText) {
  const cleaned = responseText.replace(/^\)\]\}'\s*\n/, "");
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);

  const images = [];
  let conversationId = null;
  let responseId = null;
  let modelName = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\d+$/.test(line)) continue;

    let outerChunk;
    try {
      outerChunk = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      Array.isArray(outerChunk) &&
      outerChunk.length > 0 &&
      Array.isArray(outerChunk[0])
    ) {
      const tag = outerChunk[0][0];
      if (tag === "di" || tag === "e" || tag === "af.httprm") continue;
    }

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

    if (Array.isArray(inner[1]) && inner[1].length >= 2) {
      conversationId = inner[1][0] || conversationId;
      responseId = inner[1][1] || responseId;
    }

    if (inner[42] && typeof inner[42] === "string") {
      modelName = inner[42];
    }

    if (inner[2] && typeof inner[2] === "object") {
      const meta = inner[2];
      if (meta["7"]) {
        const thinkingData = meta["7"];
        if (Array.isArray(thinkingData[5]) && thinkingData[5][0]) {
          console.log(`  Thinking: ${thinkingData[5][0]}`);
        }
        if (Array.isArray(thinkingData[1]) && thinkingData[1][1]) {
          const toolInfo = thinkingData[1][1];
          if (Array.isArray(toolInfo) && toolInfo[2]) {
            console.log(`  Status: ${toolInfo[2]}`);
          }
        }
      }
    }

    if (!Array.isArray(inner[4])) continue;

    for (const candidate of inner[4]) {
      if (!Array.isArray(candidate) || !candidate[12]) continue;

      const imageContainer = candidate[12];
      const allImageGroups = [];

      if (Array.isArray(imageContainer[7]?.[0])) {
        allImageGroups.push(...imageContainer[7][0]);
      }

      if (Array.isArray(imageContainer) && imageContainer[0]?.["8"]) {
        const editImages = imageContainer[0]["8"];
        if (Array.isArray(editImages[0])) {
          allImageGroups.push(...editImages[0]);
        }
      }

      for (const group of allImageGroups) {
        if (!Array.isArray(group) || !Array.isArray(group[0])) continue;

        const variants = [group[0][3], group[0][6]].filter(Boolean);

        for (const variant of variants) {
          if (!Array.isArray(variant) || !variant[3]) continue;
          const url = variant[3];
          const filename = variant[2] || "image";
          const mime = variant[11] || "image/png";
          const dimensions = variant[15];

          if (!images.find((img) => img.url === url)) {
            images.push({ url, filename, mime, dimensions });
          }
        }
      }
    }
  }

  return { images, conversationId, responseId, modelName };
}

// Download an image to a file path
export async function downloadImage(url, outputPath) {
  const cookies = getCookieString();
  console.log(`  Downloading ${path.basename(outputPath)}...`);

  const buffer = await downloadImageToBuffer(url);
  await writeFile(outputPath, buffer);
  console.log(
    `  Saved ${outputPath} (${(buffer.length / 1024).toFixed(1)} KB)`
  );
}

// Download an image to an in-memory Buffer
export async function downloadImageToBuffer(url) {
  const cookies = getCookieString();

  const headers = {
    "User-Agent": USER_AGENT,
    Referer: "https://gemini.google.com/",
    Cookie: cookies,
  };

  let currentUrl = url;
  let res;

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
    throw new Error(`Failed to download image: HTTP ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// High-level orchestrator: generate images from a prompt and optional image buffers
// imageBuffers: array of { buffer: Buffer, fileName: string, mimeType: string }
export async function generateImages(prompt, imageBuffers = []) {
  const { at, bl, fSid, pushId, clientPctx } = await getSessionTokens();
  const cookies = getCookieString();
  const clientUuid = randomUUID().toUpperCase();
  const reqId = Math.floor(100000 + Math.random() * 900000) * 100;

  // Upload input images if provided
  const attachments = [];
  for (const img of imageBuffers) {
    const uploaded = await uploadImageBuffer(
      img.buffer,
      img.fileName,
      img.mimeType,
      pushId,
      clientPctx
    );
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

  const modelId = "e051ce1aa80aa576";

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
      "User-Agent": USER_AGENT,
      Referer: "https://gemini.google.com/",
      Origin: "https://gemini.google.com",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed: HTTP ${res.status}\n${text.slice(0, 500)}`);
  }

  console.log("Streaming response received. Parsing...\n");
  const responseText = await res.text();

  const parsed = parseStreamResponse(responseText);

  console.log(`\nModel: ${parsed.modelName || "unknown"}`);
  console.log(`Conversation: ${parsed.conversationId}`);
  console.log(`Response: ${parsed.responseId}`);
  console.log(`Images found: ${parsed.images.length}\n`);

  if (parsed.images.length === 0) {
    throw new Error(
      "No images found in the response.\nRaw (first 2000 chars):\n" +
        responseText.slice(0, 2000)
    );
  }

  return parsed;
}
