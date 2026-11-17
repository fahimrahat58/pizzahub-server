import { Router } from "express";
import { verifyToken, requireRole } from "../middleware/auth.middleware.js";

const router = Router();

router.get("/protected", verifyToken, (req, res) => {
  res.json({
    success: true,
    message: "Authenticated successfully",
    user: req.user,
  });
});

router.get("/vendor-test", verifyToken, requireRole("vendor"), (_req, res) => {
  res.json({
    success: true,
    message: "Vendor access granted",
  });
});

router.get(
  "/customer-test",
  verifyToken,
  requireRole("customer"),
  (_req, res) => {
    res.json({
      success: true,
      message: "Customer access granted",
    });
  },
);

router.get("/admin-test", verifyToken, requireRole("admin"), (_req, res) => {
  res.json({
    success: true,
    message: "Admin access granted",
  });
});

export default router;
