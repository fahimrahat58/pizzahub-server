import type { Request, Response } from "express";
import { ObjectId } from "mongodb";

import { collections } from "../config/database.js";
import { userDto } from "../utils/serialize.js";
import { asyncHandler, notFound } from "../utils/errors.js";

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const user = await collections
    .users()
    .findOne({ _id: new ObjectId(req.user!.id) });
  if (!user) throw notFound("User not found");
  res.json({ success: true, user: userDto(user) });
});

export const verifyTokenEndpoint = asyncHandler(
  async (req: Request, res: Response) => {
    res.json({
      success: true,
      authenticated: true,
      user: {
        id: req.user!.id,
        role: req.user!.role,
        name: req.user!.name,
        email: req.user!.email,
        image: req.user!.image ?? null,
      },
    });
  },
);
