import type { Request, Response } from "express";

import {
  buildTasteDna,
  DEFAULT_TASTE_DNA_LIMIT,
  MAX_TASTE_DNA_LIMIT,
} from "../services/recommendation.service.js";
import { asyncHandler, badRequest, forbidden } from "../utils/errors.js";
import { firstString } from "../utils/query.js";

export const getTasteDna = asyncHandler(async (req: Request, res: Response) => {
  // Identity always comes from the verified token, never from query parameters.
  if (req.user!.role !== "customer") {
    throw forbidden("Only customers can view taste recommendations");
  }

  const rawLimit = firstString(req.query.limit);
  const limit = rawLimit === undefined ? DEFAULT_TASTE_DNA_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASTE_DNA_LIMIT) {
    throw badRequest(`limit must be between 1 and ${MAX_TASTE_DNA_LIMIT}`);
  }

  const result = await buildTasteDna(req.user!.id, limit);
  res.json({ success: true, ...result });
});
