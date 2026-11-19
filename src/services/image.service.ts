import { ApiError, badRequest } from "../utils/errors.js";
import { env, isImgBbConfigured } from "../config/env.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
} as const;

type AllowedMime = keyof typeof ALLOWED;

export interface ValidatedImage {
  mime: AllowedMime;
  base64: string;
  bytes: number;
}

const looksLikeBase64 = (value: string): boolean =>
  /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;

/** Validates MIME type, decoded size and magic bytes before any upload. */
export const validateImageInput = (input: unknown): ValidatedImage => {
  if (typeof input !== "object" || input === null) {
    throw badRequest("Image data is required");
  }
  const { dataUrl, mime } = input as { dataUrl?: unknown; mime?: unknown };

  if (typeof mime !== "string" || !(mime in ALLOWED)) {
    throw badRequest("Only JPG, PNG, WEBP and GIF images are allowed");
  }
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    throw badRequest("Image data is required");
  }

  const base64 = dataUrl.includes(",") ? dataUrl.split(",").slice(1).join(",") : dataUrl;
  if (!looksLikeBase64(base64)) {
    throw badRequest("Invalid image encoding");
  }

  const buffer = Buffer.from(base64, "base64");
  return validateImageBytes(buffer, mime);
};

/**
 * Validates a raw request body. Vercel caps function request bodies at 4.5 MB,
 * so the client sends raw bytes instead of base64 JSON to avoid inflating the
 * payload. The image bytes (and quality) are unchanged; only the encoding used
 * on the wire differs.
 */
export const validateImageBytes = (buffer: Buffer, mime: string): ValidatedImage => {
  if (!(mime in ALLOWED)) {
    throw badRequest("Only JPG, PNG, WEBP and GIF images are allowed");
  }
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    throw badRequest("Image must be smaller than 5 MB");
  }

  const expected = ALLOWED[mime as AllowedMime] as readonly number[];
  const matches = expected.every((byte, index) => buffer[index] === byte);
  if (!matches) {
    throw badRequest("File content does not match the declared image type");
  }

  return {
    mime: mime as AllowedMime,
    base64: buffer.toString("base64"),
    bytes: buffer.length,
  };
};

/** Uploads to ImgBB. The API key never leaves the server. */
export const uploadToImgBb = async (image: ValidatedImage): Promise<string> => {
  if (!isImgBbConfigured()) {
    throw new ApiError(
      503,
      "Image uploads are not configured. Set IMGBB_API_KEY on the server.",
    );
  }

  const form = new URLSearchParams();
  form.set("key", env.imgbbApiKey);
  form.set("image", image.base64);

  let response: Response;
  try {
    response = await fetch("https://api.imgbb.com/1/upload", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      // A 5 MB base64 payload can take longer than 15s on slower links.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Network failures and timeouts must not surface as a generic 500.
    throw new ApiError(
      502,
      "Image upload service is unavailable. Please try again.",
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: { url?: string; display_url?: string };
    error?: { message?: string };
  } | null;

  if (!response.ok || !payload?.data?.url) {
    throw new ApiError(
      502,
      payload?.error?.message ?? "Image upload failed. Please try again.",
    );
  }

  const url = payload.data.display_url ?? payload.data.url;
  if (!/^https:\/\/[^\s]+$/i.test(url)) {
    throw new ApiError(502, "Image upload returned an invalid image URL");
  }
  return url;
};
