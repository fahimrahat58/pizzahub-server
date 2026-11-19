import { Router } from "express";

import { getTasteDna } from "../controllers/recommendations.controller.js";
import { requireRole, verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.use(verifyToken, requireRole("customer"));

router.get("/taste-dna", getTasteDna);

export default router;
