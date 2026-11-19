import express, { Router } from "express";
import { z } from "zod";

import { uploadImage } from "../controllers/uploads.controller.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const validateJsonBody = validateBody(
  z.object({
    dataUrl: z.string().min(100, "Image data is required"),
    mime: z.enum(IMAGE_TYPES),
  }),
);

/**
 * Public endpoint used by registration (no session yet) and authenticated
 * dashboards. Raw image bodies stay below Vercel's 4.5 MB function payload
 * limit; the legacy JSON data-URL body is still accepted. A strict
 * MIME/magic-byte/size check and per-IP throttle keep it safe. The ImgBB key
 * never leaves this server.
 */
router.post(
  "/image",
  express.raw({ type: [...IMAGE_TYPES], limit: "4mb" }),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      next();
      return;
    }
    validateJsonBody(req, res, next);
  },
  uploadImage,
);

export default router;
