import { Router } from "express";

import { dashboardSummary } from "../controllers/dashboard.controller.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken);
router.get("/summary", dashboardSummary);

export default router;
