import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import session from "express-session";
import bcrypt from "bcrypt";
import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { type User } from "@shared/schema";
import connectPg from "connect-pg-simple";
import { pool } from "./db";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_COOKIE_NAME = "pocketpulse.sid";
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const REGISTER_ATTEMPT_LIMIT = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AttemptBucket = {
  count: number;
  resetAt: number;
};

const authAttemptBuckets = new Map<string, AttemptBucket>();

declare global {
  namespace Express {
    interface User {
      id: number;
      email: string;
      companyName: string;
    }
  }
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    return secret;
  }

  if (IS_PRODUCTION) {
    throw new Error("SESSION_SECRET must be set in production.");
  }

  return "cashflow-dev-secret-change-in-prod";
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function getClientIdentifier(req: Request) {
  return String(req.ip || req.socket.remoteAddress || "unknown").trim().toLowerCase();
}

function buildAttemptKey(scope: string, req: Request) {
  return `${scope}:${getClientIdentifier(req)}:${normalizeEmail(req.body?.email)}`;
}

function cleanupAttemptBuckets() {
  const now = Date.now();
  for (const [key, bucket] of Array.from(authAttemptBuckets.entries())) {
    if (bucket.resetAt <= now) {
      authAttemptBuckets.delete(key);
    }
  }
}

function createAuthRateLimit(scope: string, limit: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    cleanupAttemptBuckets();

    const now = Date.now();
    const key = buildAttemptKey(scope, req);
    const bucket = authAttemptBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      authAttemptBuckets.set(key, {
        count: 1,
        resetAt: now + AUTH_WINDOW_MS,
      });
      return next();
    }

    if (bucket.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", retryAfterSeconds.toString());
      return res.status(429).json({
        message: "Too many attempts. Please wait a few minutes and try again.",
      });
    }

    bucket.count += 1;
    authAttemptBuckets.set(key, bucket);
    next();
  };
}

function validatePassword(password: string) {
  return password.length >= 10 && password.length <= 128;
}

export function setupAuth(app: Express) {
  const PgSession = connectPg(session);

  app.use(
    session({
      store: new PgSession({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: true,
      }),
      name: SESSION_COOKIE_NAME,
      secret: getSessionSecret(),
      resave: false,
      saveUninitialized: false,
      unset: "destroy",
      cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: IS_PRODUCTION,
        sameSite: "lax",
      },
    })
  );

  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(
      { usernameField: "email" },
      async (email, password, done) => {
        try {
          const user = await storage.getUserByEmail(email);
          if (!user) return done(null, false, { message: "Invalid email or password" });

          const isValid = await bcrypt.compare(password, user.password);
          if (!isValid) return done(null, false, { message: "Invalid email or password" });

          return done(null, { id: user.id, email: user.email, companyName: user.companyName });
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      if (!user) return done(null, false);
      done(null, { id: user.id, email: user.email, companyName: user.companyName });
    } catch (err) {
      done(err);
    }
  });

  app.post("/api/auth/register", createAuthRateLimit("register", REGISTER_ATTEMPT_LIMIT), async (req: Request, res: Response) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password ?? "");
      const companyName = String(req.body?.companyName ?? "").trim();

      if (!email || !password || !companyName) {
        return res.status(400).json({ message: "Email, password, and company name are required" });
      }

      if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ message: "Enter a valid email address." });
      }

      if (!validatePassword(password)) {
        return res.status(400).json({ message: "Password must be between 10 and 128 characters." });
      }

      if (companyName.length > 120) {
        return res.status(400).json({ message: "Company name must be 120 characters or fewer." });
      }

      const existing = await storage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "Email already registered" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await storage.createUser({ email, password: hashedPassword, companyName });

      req.login({ id: user.id, email: user.email, companyName: user.companyName }, (err) => {
        if (err) return res.status(500).json({ message: "Login failed after registration" });
        return res.status(201).json({ id: user.id, email: user.email, companyName: user.companyName });
      });
    } catch {
      return res.status(500).json({ message: "Registration failed. Please try again." });
    }
  });

  app.post("/api/auth/login", createAuthRateLimit("login", LOGIN_ATTEMPT_LIMIT), (req: Request, res: Response, next: NextFunction) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    req.body.email = email;

    if (!EMAIL_PATTERN.test(email) || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    passport.authenticate("local", (err: any, user: Express.User | false, info: any) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ message: info?.message || "Invalid credentials" });

      req.login(user, (err) => {
        if (err) return next(err);
        return res.json(user);
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.logout((err) => {
      if (err) return res.status(500).json({ message: "Logout failed" });
      req.session.destroy(() => {
        res.clearCookie(SESSION_COOKIE_NAME, {
          httpOnly: true,
          sameSite: "lax",
          secure: IS_PRODUCTION,
        });
        return res.json({ message: "Logged out" });
      });
    });
  });

  app.get("/api/auth/me", (req: Request, res: Response) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: "Not authenticated" });
    return res.json(req.user);
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
}
