import type { UserRole } from "../models.js";

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  image?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
