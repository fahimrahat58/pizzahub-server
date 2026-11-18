import { Router } from "express";

import { dashboardStats } from "../controllers/admin.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/stats", dashboardStats);

export default router;
