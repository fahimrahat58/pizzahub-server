import { Router } from "express";
import { z } from "zod";

import { uploadImage } from "../controllers/uploads.controller.js";
import { validateBody } from "../middleware/validate.js";

const router = Router();

/**
 * Public endpoint used by registration (no session yet) and authenticated
 * dashboards. A strict MIME/magic-byte/size check and per-IP throttle keep it
 * safe. The ImgBB key never leaves this server.
 */
router.post(
  "/image",
  validateBody(
    z.object({
      dataUrl: z.string().min(100, "Image data is required"),
      mime: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
    }),
  ),
  uploadImage,
);

export default router;
