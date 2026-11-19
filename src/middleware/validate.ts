import type { NextFunction, Request, Response } from "express";
import { z, type ZodType } from "zod";

export const validateBody =
  <T extends ZodType>(schema: T) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(result.error);
      return;
    }
    req.body = result.data;
    next();
  };

export const objectIdSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, "Invalid id");

export const objectIdParamSchema = z.object({ id: objectIdSchema }).strict();

export const optionalObjectIdQuerySchema = z
  .object({ id: objectIdSchema.optional() })
  .strict();

// Express 5 exposes req.query as a getter, so these validators do not try to
// replace it. Controllers already read the original req.params / req.query.
export const validateParams =
  <T extends ZodType>(schema: T) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(result.error);
      return;
    }
    next();
  };

export const validateQuery =
  <T extends ZodType>(schema: T) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(result.error);
      return;
    }
    next();
  };
