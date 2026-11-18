import { Router } from "express";

import { getMe, verifyTokenEndpoint } from "../controllers/auth.controller.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/verify", verifyToken, verifyTokenEndpoint);
router.get("/me", verifyToken, getMe);

export default router;
