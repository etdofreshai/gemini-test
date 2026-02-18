export interface AuthStatus {
  authenticated: boolean;
  loginInProgress: boolean;
}

export interface GeneratedImage {
  filename: string;
  mime: string;
  dimensions: number[] | null;
  url: string;
  imageToken: string | null;
  responseChunkId: string | null;
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
  mime: string;
  bytes: number;
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
