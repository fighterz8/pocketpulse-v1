import connectPgSimple from "connect-pg-simple";
import express, { type RequestHandler } from "express";
import session from "express-session";

import { hashPassword, verifyPassword } from "./auth.js";
import { ensureUserPreferences, pool } from "./db.js";
import {
  createAccountForUser,
  createUser,
  DuplicateEmailError,
  getUserByEmailForAuth,
  getUserById,
  listAccountsForUser,
} from "./storage.js";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

const PgSession = connectPgSimple(session);

export type CreateAppOptions = {
  /** Override session store (route tests use `MemoryStore` so PostgreSQL `session` is not required). */
  sessionStore?: session.Store;
};

function defaultSessionStore() {
  return new PgSession({
    pool,
    tableName: "session",
    // Table is defined in `shared/schema.ts`; create via `npm run db:push` / migrations.
    createTableIfMissing: false,
  });
}

function sessionMiddleware(store: session.Store) {
  return session({
    store,
    name: "pocketpulse.sid",
    secret:
      process.env.SESSION_SECRET ?? "dev-session-secret-not-for-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

function saveSession(req: express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function regenerateSession(req: express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: express.Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session.userId == null) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

const sessionCookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};

export function createApp(options?: CreateAppOptions) {
  const store = options?.sessionStore ?? defaultSessionStore();
  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware(store));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/auth/me", async (req, res, next) => {
    try {
      const userId = req.session.userId;
      if (userId == null) {
        res.json({ authenticated: false });
        return;
      }

      const user = await getUserById(userId);
      if (!user) {
        await destroySession(req);
        res.clearCookie("pocketpulse.sid", sessionCookieOptions);
        res.json({ authenticated: false });
        return;
      }

      res.json({ authenticated: true, user });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const { email, password, displayName, companyName } = req.body ?? {};
      if (
        typeof email !== "string" ||
        typeof password !== "string" ||
        typeof displayName !== "string"
      ) {
        res
          .status(400)
          .json({ error: "email, password, and displayName are required" });
        return;
      }

      const passwordHash = await hashPassword(password);
      const user = await createUser({
        email,
        passwordHash,
        displayName,
        companyName:
          companyName === undefined || companyName === null
            ? null
            : String(companyName),
      });

      await regenerateSession(req);
      req.session.userId = user.id;
      await saveSession(req);
      res.status(201).json({ user });
    } catch (e) {
      if (e instanceof DuplicateEmailError) {
        res.status(409).json({ error: e.message });
        return;
      }
      next(e);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "email and password are required" });
        return;
      }

      const record = await getUserByEmailForAuth(email);
      if (
        !record ||
        !(await verifyPassword(password, record.passwordHash))
      ) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      const user = await getUserById(record.id);
      if (!user) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }

      await ensureUserPreferences(record.id);
      await regenerateSession(req);
      req.session.userId = record.id;
      await saveSession(req);
      res.json({ user });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/auth/logout", (req, res, next) => {
    if (!req.session) {
      res.status(204).end();
      return;
    }
    req.session.destroy((err) => {
      if (err) {
        next(err);
        return;
      }
      res.clearCookie("pocketpulse.sid", sessionCookieOptions);
      res.status(204).end();
    });
  });

  app.get("/api/accounts", requireAuth, async (req, res, next) => {
    try {
      const userId = req.session.userId!;
      const accounts = await listAccountsForUser(userId);
      res.json({ accounts });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/accounts", requireAuth, async (req, res, next) => {
    try {
      const { label, lastFour, accountType } = req.body ?? {};
      if (typeof label !== "string" || !label.trim()) {
        res.status(400).json({ error: "label is required" });
        return;
      }

      const userId = req.session.userId!;
      const account = await createAccountForUser(userId, {
        label: label.trim(),
        lastFour:
          lastFour === undefined || lastFour === null
            ? null
            : String(lastFour),
        accountType:
          accountType === undefined || accountType === null
            ? null
            : String(accountType),
      });
      res.status(201).json({ account });
    } catch (e) {
      next(e);
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  return app;
}
