import type { Request, Response } from "express";

import { buildDashboardSummary } from "../services/dashboard.service.js";
import { forbidden, asyncHandler } from "../utils/errors.js";

export const dashboardSummary = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw forbidden("Authentication required");
  const summary = await buildDashboardSummary(req.user);
  res.json({ success: true, summary });
});
