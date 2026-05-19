# Technical System — v2

A multi-brand restaurant operations platform: menu management with role-based access, item hide/unhide workflow, call-center case management, busy-branch tracking, late-order/dedication handling, and analytics.

## Status

This is the **v2** rewrite of the system. The original lives at https://github.com/swish-code/Technical_System_Final and is still in production. v2 starts from the same codebase with the most critical security holes already closed (see *Changes from v1* below). The plan is to migrate the running system over once v2 reaches feature parity and the security debt is fully paid down.

Audit context for v1 (issues we're fixing here) is documented in `TECHNICAL_SYSTEM_ANALYSIS.md` and `RAILWAY_LOG_ANALYSIS.md` in the v1 workspace.

## Stack

- **Backend**: Node.js (tsx) + Express 4 + WebSocket (ws) on port 3000
- **Database**: PostgreSQL (`pg`)
- **Auth**: JWT (HS256) + bcrypt
- **Frontend**: React 19 + Vite 6 + Tailwind 4 + TypeScript
- **Notifications**: web-push (VAPID), service worker
- **File uploads**: multer (currently to local disk — see open issues)

## Run locally

**Prerequisites:** Node.js 20+, a Postgres instance.

```bash
npm install
cp .env.example .env.local        # then fill in the values (see below)
npm run dev
```

### Required environment variables

The server now refuses to start without these (see `requireEnv()` in `server.ts`):

| Variable | What |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Random 32+ byte hex string used to sign tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `VAPID_PUBLIC_KEY` | Web-push VAPID public key |
| `VAPID_PRIVATE_KEY` | Web-push VAPID private key. Generate the pair with `npx web-push generate-vapid-keys`. |

### Optional

| Variable | What |
|---|---|
| `GEMINI_API_KEY` | Reserved for future AI features. Currently unused. **Set on the backend only** — do NOT expose to the frontend via `vite.config.ts` `define`. |
| `NODE_ENV` | `production` for deploys; absent in dev. |

## Changes from v1

This initial commit makes the following deltas from `swish-code/Technical_System_Final` (audit refs in brackets):

- **No hardcoded secret fallbacks.** `JWT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` now fail-fast via a `requireEnv()` helper instead of silently falling back to literals in source. **v2 will refuse to start if any of these three variables is missing — this is intentional, not a bug; the previous silent fallback meant production was signing tokens with a public string from the source code.** [S-1, S-3]
- **`seedData()` no longer deletes unknown brands.** The previous version ran `DELETE FROM products/branches/brands` on every restart for any brand not in `ALLOWED_BRANDS`. Now logs a warning and preserves the data; merge logic for known variations is unchanged. [S-8]

## Known open issues (not yet addressed in this commit)

These are the rest of v1's Sprint-1 items; we'll work through them in follow-up commits before this branch goes live:

- JWTs are issued without `expiresIn`; tokens never expire. [S-2]
- Default `admin/admin123`, `Super Visor/supervisor123`, `marketing_team/marketing123` are still seeded on every startup. [S-4]
- WebSocket server has no auth at the handshake; broadcasts go to every connected client. [S-5, S-15]
- `/uploads` is served by `express.static` with no auth and no MIME filter. Uploads live on ephemeral container disk — **a Railway volume must be attached at `/app/uploads` before any real attachments are accepted**. [S-6 + new finding]
- `vite.config.ts` `define` exposes `GEMINI_API_KEY` to the frontend bundle. Currently mitigated by `@google/genai` not being imported anywhere, but should be removed. [S-7]
- CORS is wide-open. [S-11]
- Service worker in `public/sw.js` has no `push` listener; `index.html` unregisters service workers on every page load. Push notifications are non-functional today. [S-18]
- `xlsx` parses user-uploaded files (CVE-2023-30533). [S-9]
- No rate limiting on `/api/login`. [S-10]

See the v1 audit for the full list (S-1 through S-24, Q-1 through Q-10) and the prioritized remediation order.

## Repository layout

```
server.ts            # Monolithic backend (~6.3K lines — split planned)
src/                 # React frontend
  components/        # Dashboard + views + modals
  context/           # Auth + Theme
  hooks/             # useFetch, useWebSocket
  lib/               # utils, notification helper
public/              # Static assets including manifest.json + sw.js
index.html
package.json
tsconfig.json
vite.config.ts
```
