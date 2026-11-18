import type { Request } from "express";

export const firstString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
};

export const getPagination = (req: Request): { page: number; limit: number } => {
  const page = Math.max(1, Number(firstString(req.query.page) ?? 1) || 1);
  const limit = Math.min(
    50,
    Math.max(1, Number(firstString(req.query.limit) ?? 12) || 12),
  );
  return { page, limit };
};

export const isValidObjectId = (id: string): boolean =>
  /^[a-fA-F0-9]{24}$/.test(id);
