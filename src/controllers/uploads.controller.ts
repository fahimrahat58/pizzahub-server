import type { Request, Response } from "express";

import { ApiError, asyncHandler } from "../utils/errors.js";
import { uploadToImgBb, validateImageInput } from "../services/image.service.js";

/** Simple per-IP throttle for the unauthenticated registration upload. */
const uploadWindow = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 12;

const clientIp = (req: Request): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]!.trim();
  return req.ip ?? "unknown";
};

const throttle = (req: Request): void => {
  const key = clientIp(req);
  const now = Date.now();
  const recent = (uploadWindow.get(key) ?? []).filter(
    (timestamp) => now - timestamp < WINDOW_MS,
  );
  if (recent.length >= MAX_PER_WINDOW) {
    throw new ApiError(429, "Too many image uploads. Please try again later.");
  }
  recent.push(now);
  uploadWindow.set(key, recent);
  if (uploadWindow.size > 2_000) uploadWindow.clear();
};

export const uploadImage = asyncHandler(async (req: Request, res: Response) => {
  throttle(req);
  const image = validateImageInput(req.body);
  const url = await uploadToImgBb(image);

  res.json({
    success: true,
    url,
    mime: image.mime,
    size: image.bytes,
  });
});
