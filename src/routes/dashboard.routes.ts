import { Router } from "express";

import { dashboardSummary } from "../controllers/dashboard.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken);
router.get("/summary", requireRole("customer", "vendor", "admin"), dashboardSummary);

export default router;
