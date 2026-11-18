import { Router } from "express";

import {
  dashboardStats,
  listTransactions,
} from "../controllers/admin.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/stats", dashboardStats);
router.get("/transactions", listTransactions);

export default router;
