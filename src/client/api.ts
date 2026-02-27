export interface AuthStatus {
  authenticated: boolean;
  loginInProgress: boolean;
}

export interface GeneratedImage {
  filename: string;
  mime: string;
  dimensions: number[] | null;
  url: string;
  savedName?: string;
  upscaleId?: string;
  upscaleLink?: string;
  prompt?: string;
  aspectRatio?: string;
}

export interface GenerateResult {
  images: GeneratedImage[];
  metadata: {
    conversationId: string | null;
    responseId: string | null;
    modelName: string | null;
    prompt: string;
  };
}

export interface UpscaleResult {
  url: string;
  savedName?: string;
  mime: string;
  bytes: number;
}

export interface StoredImage {
  filename: string;
  url: string;
  bytes: number;
  createdAt: number;
  prompt?: string;
  aspectRatio?: string;
}

export async function checkAuth(): Promise<AuthStatus> {
  const res = await fetch("/api/status");
  return res.json();
}

export async function doLogin(): Promise<{ success?: boolean; error?: string; redirect?: string }> {
  const res = await fetch("/api/login");
  const data = await res.json();
  if (data.redirect) {
    window.location.href = data.redirect;
  }
  return data;
}

export async function generate(
  prompt: string,
  files: FileList | null,
  aspectRatio?: string
): Promise<GenerateResult> {
  const form = new FormData();
  form.append("prompt", prompt);
  if (aspectRatio) form.append("aspectRatio", aspectRatio);
  if (files) {
    for (const file of files) {
      form.append("images", file);
    }
  }
  const res = await fetch("/api/generate", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

export async function upscale(params: {
  imageToken: string;
  responseChunkId: string;
  conversationId: string;
  responseId: string;
  prompt: string;
}): Promise<UpscaleResult> {
  const res = await fetch("/api/upscale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

/**
 * Get the upscale link URL for a given upscale ID.
 * The link performs the upscale and redirects to the result image.
 */
export function getUpscaleLinkUrl(upscaleId: string): string {
  return `/api/upscale-link/${upscaleId}`;
}

/**
 * Perform a one-click upscale using a server-stored token.
 * Returns the redirect URL to the upscaled image.
 */
export async function upscaleByLink(upscaleId: string): Promise<string> {
  const res = await fetch(`/api/upscale-link/${upscaleId}`, {
    redirect: "manual", // Don't follow redirects automatically
  });
  
  if (res.status === 302) {
    const location = res.headers.get("location");
    if (location) {
      return location;
    }
  }
  
  const data = await res.json().catch(() => ({ error: `Error ${res.status}` }));
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status}`);
  }
  
  throw new Error("Unexpected response from upscale endpoint");
}

export async function listImages(): Promise<{ images: StoredImage[] }> {
  const res = await fetch("/api/images");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

export async function deleteImage(filename: string): Promise<void> {
  const res = await fetch(`/api/images/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
}

export async function deleteImages(filenames: string[]): Promise<{ deleted: string[]; errors: string[] }> {
  const res = await fetch("/api/images", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
