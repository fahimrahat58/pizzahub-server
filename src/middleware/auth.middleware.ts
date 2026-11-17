import "dotenv/config";

import type { Request, Response, NextFunction } from "express";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { db } from "../config/database.js";

const authURL = process.env.BETTER_AUTH_URL;

if (!authURL) {
  throw new Error("BETTER_AUTH_URL is missing");
}

const JWKS = createRemoteJWKSet(new URL(`${authURL}/api/auth/jwks`));

type UserRole = "admin" | "vendor" | "customer";

interface AuthUser {
  _id: string;
  role: UserRole;
  isBlocked?: boolean;
}

export const verifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication token is required",
      });
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Invalid authorization header",
      });
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: authURL,
      audience: authURL,
    });

    const userId = payload.sub;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    // Always read the latest user data from MongoDB.
    // This ensures role/block status is not taken
    // from potentially stale JWT data.
    const user = await db.collection<AuthUser>("users").findOne({
      _id: userId,
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.isBlocked === true) {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked",
      });
    }

    const validRoles: UserRole[] = ["admin", "vendor", "customer"];

    if (!validRoles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: "Invalid user role",
      });
    }

    req.user = {
      id: user._id,
      role: user.role,
    };

    next();
  } catch (error) {
    console.error("Authentication error:", error);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
};

export const requireRole = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission",
      });
    }

    next();
  };
};
