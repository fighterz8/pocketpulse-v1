# PocketPulse

Small-business cashflow analysis web application.

## Status
Workspace wiped — ready for reimplementation under new tech spec.

## Infrastructure
- PostgreSQL database available via `DATABASE_URL` environment variable (tables dropped, clean slate)
- GitHub connected at https://github.com/fighterz8/pocketpulse
- Port 5000 mapped to external port 80; `npm run dev` runs Express + Vite on that port (no separate API process for preview)
