import type { UserRole } from "./models.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: UserRole;
        name: string;
        email: string;
        image?: string | null;
      };
    }
  }
}

export {};
