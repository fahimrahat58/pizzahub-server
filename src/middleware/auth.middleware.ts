import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ObjectId } from "mongodb";

import { collections } from "../config/database.js";
import { env } from "../config/env.js";
import type { UserRole } from "../types/models.js";
import { isValidObjectId } from "../utils/query.js";

const JWKS = createRemoteJWKSet(new URL(`${env.authUrl}/api/auth/jwks`));

/**
 * Verifies the Better Auth JWT (signature, exp, iss, aud), confirms the
 * underlying Better Auth session is still alive, then loads the *current*
 * role and blocked status from MongoDB. Nothing from the token is trusted
 * for authorization decisions.
 */
export const verifyToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      res
        .status(401)
        .json({ success: false, message: "Authentication token is required" });
      return;
    }

    const token = authorization.slice(7).trim();
    if (!token) {
      res
        .status(401)
        .json({ success: false, message: "Invalid authorization header" });
      return;
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.authUrl,
      audience: env.authUrl,
    });

    const userId = payload.sub;
    if (!userId || !isValidObjectId(userId)) {
      res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
      return;
    }
    const userObjectId = new ObjectId(userId);

    if (typeof payload.sessionId === "string") {
      if (!isValidObjectId(payload.sessionId)) {
        res
          .status(401)
          .json({ success: false, message: "Invalid token payload" });
        return;
      }
      // Better Auth's Mongo adapter stores session ids as ObjectIds in the
      // singular `session` collection.
      const session = await collections.sessions().findOne({
        _id: new ObjectId(payload.sessionId),
        userId: userObjectId,
        expiresAt: { $gt: new Date() },
      });
      if (!session) {
        res.status(401).json({
          success: false,
          message: "Session expired. Please sign in again.",
        });
        return;
      }
    }

    const user = await collections.users().findOne(
      { _id: userObjectId },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          isBlocked: 1,
        },
      },
    );

    if (!user) {
      res.status(401).json({ success: false, message: "User not found" });
      return;
    }

    if (user.isBlocked === true) {
      res.status(403).json({
        success: false,
        code: "ACCOUNT_BLOCKED",
        message: "Your account has been blocked",
      });
      return;
    }

    const validRoles: UserRole[] = ["admin", "vendor", "customer"];
    if (!validRoles.includes(user.role)) {
      res.status(403).json({ success: false, message: "Invalid user role" });
      return;
    }

    req.user = {
      id: user._id.toHexString(),
      role: user.role,
      name: user.name,
      email: user.email,
      image: user.image,
    };
    next();
  } catch (error) {
    // A missing/expired JWT or unreachable JWKS is an authentication failure.
    void error;
    res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
};

export const requireRole =
  (...roles: UserRole[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: "You do not have permission" });
      return;
    }
    next();
  };
