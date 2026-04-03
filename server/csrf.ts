import { doubleCsrf } from "csrf-csrf";

const csrfSecret =
  process.env.CSRF_SECRET ?? process.env.SESSION_SECRET ?? "dev-csrf-secret";

export const {
  generateToken,
  doubleCsrfProtection,
  invalidCsrfTokenError,
} = doubleCsrf({
  getSecret: () => csrfSecret,
  cookieName: "pocketpulse.csrf",
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  },
  getTokenFromRequest: (req) =>
    req.headers["x-csrf-token"] as string | undefined,
});
