import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { ObjectId } from "mongodb";

import { collections } from "../config/database.js";
import { env } from "../config/env.js";
import type { UserRole } from "../types/models.js";
import { isValidObjectId } from "../utils/query.js";

const JWKS = createRemoteJWKSet(new URL(`${env.authUrl}/api/auth/jwks`));

const AUTH_UNAVAILABLE_MESSAGE = "Authentication is temporarily unavailable";

const isJwtValidationError = (error: unknown): boolean =>
  error instanceof errors.JWTExpired ||
  error instanceof errors.JWTClaimValidationFailed ||
  error instanceof errors.JOSEAlgNotAllowed ||
  error instanceof errors.JWSInvalid ||
  error instanceof errors.JWTInvalid ||
  error instanceof errors.JWSSignatureVerificationFailed ||
  error instanceof errors.JWKSNoMatchingKey;

const respondWithAuthUnavailable = (
  res: Response,
  context: string,
  error: unknown,
): void => {
  console.error(
    context,
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          ...("code" in error ? { code: String(error.code) } : {}),
        }
      : { name: "UnknownError" },
  );
  res.status(503).json({
    success: false,
    message: AUTH_UNAVAILABLE_MESSAGE,
  });
};

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
  let payload: JWTPayload;

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

    ({ payload } = await jwtVerify(token, JWKS, {
      issuer: env.authUrl,
      audience: env.authUrl,
      // Better Auth's default JWKS keyPairConfig is EdDSA / Ed25519 and this
      // app does not override jwks.keyPairConfig or jwt.sign.
      algorithms: ["EdDSA"],
    }));
  } catch (error) {
    if (isJwtValidationError(error)) {
      res.status(401).json({
        success: false,
        message: "Invalid or expired authentication token",
      });
      return;
    }
    respondWithAuthUnavailable(res, "JWT verification dependency failure", error);
    return;
  }

  try {
    const userId = payload.sub;
    if (!userId || !isValidObjectId(userId)) {
      res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
      return;
    }
    const userObjectId = new ObjectId(userId);

    if (
      typeof payload.sessionId !== "string" ||
      !isValidObjectId(payload.sessionId)
    ) {
      res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
      return;
    }

    // Better Auth's Mongo adapter stores session ids as ObjectIds in the
    // singular `session` collection. Always verify the live session.
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
    respondWithAuthUnavailable(res, "Authentication dependency failure", error);
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
