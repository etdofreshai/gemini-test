import { readFile, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";
import { lookup } from "mime-types";
import { getCookieString, refreshCookiesFromResponse } from "./cookies.js";

const GEMINI_URL = "https://gemini.google.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

export interface SessionTokens {
  at: string;
  bl: string;
  fSid: string;
  pushId: string | null;
  clientPctx: string | null;
}

interface UploadedImage {
  uploadPath: string;
  fileName: string;
  mimeType: string;
}

export interface ParsedImage {
  url: string;
  filename: string;
  mime: string;
  dimensions: number[] | null;
  imageToken: string | null;
  responseChunkId: string | null;
}

export interface ParsedResponse {
  images: ParsedImage[];
  conversationId: string | null;
  responseId: string | null;
  modelName: string | null;
}

// Fetch the Gemini page and extract session tokens from the HTML
export async function getSessionTokens(): Promise<SessionTokens> {
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
export async function uploadImage(
  filePath: string,
  pushId: string | null,
  clientPctx: string | null
): Promise<UploadedImage> {
  const fileName = path.basename(filePath);
  const fileBuffer = await readFile(filePath);
  const mimeType = lookup(filePath) || "image/jpeg";
  return uploadImageBuffer(fileBuffer, fileName, mimeType, pushId, clientPctx);
}

// Upload an image from an in-memory buffer
export async function uploadImageBuffer(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  pushId: string | null,
  clientPctx: string | null
): Promise<UploadedImage> {
  const cookies = getCookieString();
  const fileSize = buffer.length;

  console.log(
    `  Uploading ${fileName} (${(fileSize / 1024).toFixed(1)} KB, ${mimeType})...`
  );

  // Phase 1: Initiate upload
  const initHeaders: Record<string, string> = {
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(fileSize),
    "X-Tenant-Id": "bard-storage",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Cookie: cookies,
    "User-Agent": USER_AGENT,
    Origin: "https://gemini.google.com",
    Referer: "https://gemini.google.com/",
  };
  if (pushId) initHeaders["Push-ID"] = pushId;
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
    body: new Uint8Array(buffer),
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload finalize failed: HTTP ${uploadRes.status}`);
  }

  const uploadPath = await uploadRes.text();
  console.log(`  Uploaded -> ${uploadPath.slice(0, 60)}...`);

  return { uploadPath: uploadPath.trim(), fileName, mimeType };
}

// Build the f.req payload for StreamGenerate
export function buildRequestPayload(
  prompt: string,
  at: string,
  clientUuid: string,
  attachments: UploadedImage[] = []
): string {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1000000;

  const inner: any[] = new Array(69).fill(null);
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
export function parseStreamResponse(responseText: string): ParsedResponse {
  const cleaned = responseText.replace(/^\)\]\}'\s*\n/, "");
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);

  const images: ParsedImage[] = [];
  let conversationId: string | null = null;
  let responseId: string | null = null;
  let modelName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^\d+$/.test(line)) continue;

    let outerChunk: any;
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

    let inner: any;
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

      // Extract response chunk ID (rc_xxx) from candidate[0]
      const chunkId =
        typeof candidate[0] === "string" && candidate[0].startsWith("rc_")
          ? candidate[0]
          : null;

      const imageContainer = candidate[12];
      const allImageGroups: any[] = [];

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
          const dimensions = variant[15] || null;
          // variant[5] contains the image token needed for full-size download
          const imageToken =
            typeof variant[5] === "string" ? variant[5] : null;

          if (!images.find((img) => img.url === url)) {
            console.log(`  Image: ${filename} (${mime}) ${dimensions ? dimensions.join("x") : "?"}  token=${imageToken ? imageToken.slice(0, 30) + "..." : "NONE"}  chunkId=${chunkId || "NONE"}`);
            images.push({
              url,
              filename,
              mime,
              dimensions,
              imageToken,
              responseChunkId: chunkId,
            });
          }
        }
      }
    }
  }

  return { images, conversationId, responseId, modelName };
}

// Download an image to a file path
export async function downloadImage(
  url: string,
  outputPath: string
): Promise<void> {
  console.log(`  Downloading ${path.basename(outputPath)}...`);

  const buffer = await downloadImageToBuffer(url);
  await writeFile(outputPath, buffer);
  console.log(
    `  Saved ${outputPath} (${(buffer.length / 1024).toFixed(1)} KB)`
  );
}

// Download an image to an in-memory Buffer.
// Handles both HTTP 3xx redirects and Google's "soft redirects" where a 200 text/plain
// response body contains the next URL to follow.
export async function downloadImageToBuffer(url: string): Promise<Buffer> {
  const cookies = getCookieString();

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: "https://gemini.google.com/",
    Cookie: cookies,
  };

  let currentUrl = url;
  let res!: Response;

  for (let i = 0; i < 8; i++) {
    res = await fetch(currentUrl, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });

    // Handle HTTP 3xx redirects
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      currentUrl = location;
      console.log(`    Redirect ${i + 1} -> ${new URL(currentUrl).hostname}...`);
      continue;
    }

    if (!res.ok) break;

    // Handle Google's soft redirects: 200 OK with text/plain body containing a URL
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/plain")) {
      const body = await res.text();
      const trimmed = body.trim();
      if (trimmed.startsWith("https://")) {
        currentUrl = trimmed;
        console.log(`    Soft redirect ${i + 1} -> ${new URL(currentUrl).hostname}...`);
        continue;
      }
    }

    break;
  }

  if (!res.ok) {
    throw new Error(`Failed to download image: HTTP ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// Request a full-size (2K/4K) image URL via the c8o8Fe batchexecute RPC.
// This is the second step Gemini uses — the initial StreamGenerate only returns ~1K previews.
export async function requestFullSizeUrl(
  image: ParsedImage,
  prompt: string,
  conversationId: string,
  responseId: string,
  tokens: SessionTokens
): Promise<string> {
  const cookies = getCookieString();
  const { at, bl, fSid } = tokens;
  const reqId = Math.floor(100000 + Math.random() * 900000) * 100;

  // Generate a client request token (random alphanumeric, ~16 chars)
  const requestToken = randomUUID().replace(/-/g, "").slice(0, 16);

  const convIdBare = conversationId.replace(/^c_/, "");

  // 5-element outer: [10-element inner, 5-element IDs, 1, 0, 1]
  // Inner[0-3]: image data, url ref, null, prompt
  // Inner[4-8]: five nulls
  // Inner[9]: requestToken
  const innerPayload = [
    [
      [null, null, null, [null, null, null, null, null, image.imageToken]],
      ["http://googleusercontent.com/image_generation_content/0", 0],
      null,
      [19, prompt],
      null, null, null, null, null,
      requestToken,
    ],
    [responseId, image.responseChunkId, conversationId, null, requestToken],
    1,
    0,
    1,
  ];

  const outerPayload = [
    [["c8o8Fe", JSON.stringify(innerPayload), null, "generic"]],
  ];

  const url = new URL(`${GEMINI_URL}/_/BardChatUi/data/batchexecute`);
  url.searchParams.set("rpcids", "c8o8Fe");
  url.searchParams.set("source-path", `/app/${convIdBare}`);
  url.searchParams.set("bl", bl);
  url.searchParams.set("f.sid", fSid);
  url.searchParams.set("hl", "en");
  url.searchParams.set("_reqid", String(reqId));
  url.searchParams.set("rt", "c");

  const body = new URLSearchParams();
  body.set("f.req", JSON.stringify(outerPayload));
  body.set("at", at);

  console.log(`  Requesting full-size URL for ${image.filename}...`);
  console.log(`    imageToken: ${image.imageToken?.slice(0, 40)}...`);
  console.log(`    responseChunkId: ${image.responseChunkId}`);
  console.log(`    responseId: ${responseId}`);
  console.log(`    conversationId: ${conversationId}`);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Same-Domain": "1",
      "x-goog-ext-73010989-jspb": "[0]",
      "x-goog-ext-525001261-jspb": JSON.stringify([
        1, null, null, null, null, null, null, 0, [4, 4],
      ]),
      Cookie: cookies,
      "User-Agent": USER_AGENT,
      Referer: "https://gemini.google.com/",
      Origin: "https://gemini.google.com",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000), // 30 second timeout
  });

  if (!res.ok) {
    throw new Error(`Full-size request failed: HTTP ${res.status}`);
  }

  const text = await res.text();
  // Response is Google's streaming format: )]}'\n<len>\n[["wrb.fr","c8o8Fe","[\"<url>\"]",...]]
  // The inner data is a JSON string within a JSON array, so we parse the line as JSON first.
  const cleaned = text.replace(/^\)\]\}'\s*\n/, "");
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);

  let fullSizeUrl: string | null = null;
  for (const line of lines) {
    if (/^\d+$/.test(line.trim())) continue;
    try {
      const parsed = JSON.parse(line);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (Array.isArray(entry) && entry[0] === "wrb.fr" && entry[1] === "c8o8Fe" && entry[2]) {
          const inner = JSON.parse(entry[2]);
          fullSizeUrl = inner[0];
          break;
        }
      }
      if (fullSizeUrl) break;
    } catch {
      continue;
    }
  }

  if (!fullSizeUrl) {
    console.error("  c8o8Fe response (first 1000 chars):", text.slice(0, 1000));
    throw new Error("Could not parse full-size URL from c8o8Fe response");
  }

  // Append download suffix — this tells Google to serve the full-resolution image
  const downloadUrl = `${fullSizeUrl}=d-I?alr=yes`;
  console.log(`  Full-size URL: ${downloadUrl.slice(0, 120)}...`);
  return downloadUrl;
}

// High-level orchestrator: generate images from a prompt and optional image buffers
export async function generateImages(
  prompt: string,
  imageBuffers: Array<{ buffer: Buffer; fileName: string; mimeType: string }> = []
): Promise<ParsedResponse & { tokens: SessionTokens }> {
  const tokens = await getSessionTokens();
  const { at, bl, fSid, pushId, clientPctx } = tokens;
  const cookies = getCookieString();
  const clientUuid = randomUUID().toUpperCase();
  const reqId = Math.floor(100000 + Math.random() * 900000) * 100;

  // Upload input images if provided
  const attachments: UploadedImage[] = [];
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

  const modelId = "9d8ca3786ebdfbea"; // Gemini 3.0 Pro

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
        1, null, null, null, modelId, null, null, 0, [4], null, null, 1,
      ]),
      "x-goog-ext-525005358-jspb": JSON.stringify([clientUuid, 1]),
      Cookie: cookies,
      "User-Agent": USER_AGENT,
      Referer: "https://gemini.google.com/",
      Origin: "https://gemini.google.com",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(120_000), // 2 minute timeout
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Request failed: HTTP ${res.status}\n${text.slice(0, 500)}`
    );
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
      "Gemini returned text instead of images. Try rephrasing your prompt to be more specific about image generation."
    );
  }

  return { ...parsed, tokens };
}
