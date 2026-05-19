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
- **JWTs now expire after 8h** (`expiresIn: "8h"` on `jwt.sign`). v1 issued tokens that never expired. [S-2]
- **No hardcoded default-password user seeds.** v1 created `admin/admin123`, `Super Visor/supervisor123`, and `marketing_team/marketing123` on every startup, then force-reset admin's role to Manager. All four blocks are removed. First-time bootstrap is now a one-shot SQL operation; see *First-time bootstrap* below. [S-4]
- **No `GEMINI_API_KEY` in the frontend bundle.** Removed the `vite.config.ts` `define` that substituted the key at build time. If you wire up Gemini later, do it backend-only and proxy via an API route. [S-7]
- **No wide-open CORS.** Removed `app.use(cors())`. The frontend is served same-origin in both dev (Vite middleware) and prod (`express.static(dist/)`), so CORS isn't needed at all. If a cross-origin setup is required later, add `cors({ origin: <whitelist> })` explicitly. [S-11]
- **"Test Notification" button removed** from the Dashboard. It POSTed real `late_order_requests` rows with `customer_name: "Test Customer"` and also generated 403 noise because Manager wasn't in the route's `authorize()` list. [S-16, N-3]
- **`POST /api/late-orders` no longer crashes on empty `dedication_time`.** Coerces `""` to `null` before insert. [N-1]
- **Request and auth logs redacted.** Request logger prints `method + path` (no query string); all `[LOGIN]` username logs removed. Catch-all `204` on `/favicon.ico`, `/apple-touch-icon*`, `/.well-known/*` so PWA/iOS probes don't pollute logs. [S-12, N-5]
- **`/api/login` rate-limited:** 5 failed attempts per 15 minutes per IP (successful logins reset the counter via `skipSuccessfulRequests`). [S-10]
- **No external CDN dependencies in the browser.** Self-hosted Web Audio API alarms via `src/lib/audio.ts` instead of `assets.mixkit.co`; removed the decorative `picsum.photos` avatars. [S-17]
- **Working web-push service worker.** `public/sw.js` now has real `push` + `notificationclick` handlers; removed the script in `index.html` that unregistered all service workers on every load. [S-18]
- **`/uploads` is locked down.** Multer has a MIME whitelist (image/* + pdf) and 10 MB cap. The saved filename uses our own extension based on MIME, never the client-supplied name. The static route requires authentication. [S-6]
- **httpOnly cookie auth, no JWT in localStorage.** Backend sets `swish_token` as `HttpOnly + SameSite=Lax + Secure` (in prod). Frontend uses `credentials: 'include'` everywhere; ~30 inline `localStorage.getItem('token')` reads across 9 files removed. `/api/logout` clears the cookie. [S-13, S-14]
- **WebSocket auth at handshake + role-filtered broadcasts.** WS upgrades reject without a valid `swish_token` cookie; `broadcast()` filters by `role_target` and `user_id`. `DEDICATION_ALERT` now targets `["Call Center", "Restaurants"]` only so customer PII doesn't leak to back-office roles. [S-5, S-15 part 1]

## First-time bootstrap

Because v2 doesn't auto-seed any users, a fresh database needs at least one operator account created manually. Run this once against your Postgres:

```sql
-- 1. Make sure roles exist (server.ts seeds these on first startup; run after the server has booted once)
SELECT id, name FROM roles;

-- 2. Create the first admin. Replace <BCRYPT_HASH> with the output of:
--    node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" '<your_chosen_password>'
INSERT INTO users (username, password_hash, role_id)
SELECT 'admin', '<BCRYPT_HASH>', id FROM roles WHERE name = 'Manager';
```

For migrations from v1, the database is cloned wholesale and this step is unnecessary — all 137 v1 users come over intact.

## Known open issues (deployment / refactor items, no code change pending)

Sprint 1 of the v1 audit roadmap is **complete in code**. What remains is deploy-time configuration and follow-up refactoring:

**Deployment configuration (needed before going live):**
- **Attach a Railway volume to the backend service at `/app/uploads`** — currently the upload dir is on ephemeral container disk, so every restart loses all attachments. Code is ready (auth + MIME whitelist landed); the volume is a Railway dashboard action.
- **Set `JWT_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` env vars in the Railway project** — the server now `requireEnv()`s these and will fail-fast otherwise.
- **Bootstrap the first admin user** via the SQL in *First-time bootstrap* above once the DB is up.

**Refactor follow-ups (code works but could be tighter):**
- ~30 inline `localStorage.getItem('token')` reads have been removed (S-13/S-14), but the codebase still has 4 separate WebSocket connections per session (Dashboard via `useWebSocket` + HideItemView + OrdersView + UnhideItemView each open their own). All four are now authenticated, but should be multiplexed into a single Context-shared connection. [S-15 part 2]
- Component sizes are still huge (`AnalyticsView` 1,457L, `LateOrdersView` 1,296L, `ManagerView` 1,226L). [Q-1]
- No automated tests. [Q-5]
- Schema migrations still run as idempotent `try/catch ALTER TABLE` on every startup. Should be moved to a real migration tool (`node-pg-migrate`). [Q-6, Q-7]
- The 1,400-line hardcoded product catalog in `server.ts:1043+` should move out of source into a JSON seed file. [Q-9]
- Dead deps to remove: `better-sqlite3`, `@google/genai`, `react-router-dom` (installed, never imported). [Q-10]

**Downgraded:**
- **S-9 (xlsx CVE-2023-30533)** — the audit raised this because `xlsx` is in dependencies and the parser has known prototype-pollution issues. Confirmed via grep: `xlsx` is only used **server-side for writing** export files (`XLSX.write`, `json_to_sheet`, `book_append_sheet`). No `XLSX.read` or `sheet_to_json` on the server. The CVE specifically affects parsing untrusted input, which we never do. Frontend `LateOrdersView` does import `xlsx` for client-side export only. No code change needed in this branch; revisit if anyone wires up server-side Excel parsing.

See the v1 audit for the full list (S-1 through S-24, Q-1 through Q-10) and the original prioritized remediation order.

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
