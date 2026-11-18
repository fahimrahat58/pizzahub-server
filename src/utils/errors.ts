import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MongoServerError } from "mongodb";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, message, details);
export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, message);
export const forbidden = (message = "You do not have permission") =>
  new ApiError(403, message);
export const notFound = (message = "Resource not found") =>
  new ApiError(404, message);
export const conflict = (message: string) => new ApiError(409, message);

export const asyncHandler =
  <T extends Request = Request>(
    fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
  ) =>
  (req: T, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (error instanceof ApiError) {
    res.status(error.status).json({
      success: false,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: "Invalid input",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  if (error instanceof MongoServerError && error.code === 11000) {
    res.status(409).json({
      success: false,
      message: "A record with these details already exists",
    });
    return;
  }

  // Body-parser errors (malformed JSON, oversized payloads) are plain Error
  // objects with a status. Without this branch they became a generic 500,
  // which hid the real upload problem from the client.
  const status = statusOf(error);
  if (status !== null && status >= 400 && status < 500) {
    res.status(status).json({
      success: false,
      message: clientMessage(error, status),
    });
    return;
  }

  console.error("Unhandled API error:", error);
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

const statusOf = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

const clientMessage = (error: unknown, status: number): string => {
  if (typeof error !== "object" || error === null) return "Invalid request";
  const type = (error as { type?: unknown }).type;
  if (type === "entity.too.large" || status === 413) {
    return "The image is too large. Choose a file under 5 MB.";
  }
  if (type === "entity.parse.failed") return "Invalid JSON request body";
  if (status === 400) return "Invalid request";
  return "Request could not be completed";
};
