# Zira Go — full bundle

Everything built so far for Zira Go (the transport layer of ZiraPay), packaged
together: trip charging, Telegram linking + bot, login/auth, and bank-account
verification with an admin-gated change process.

**Read this before you deploy anything.** A few pieces here are deliberately
left as stubs because they need YOUR real credentials/infrastructure, not
placeholders I could safely guess — they're called out below.

## What's in this zip

### Database
- `zira_go_schema.sql` — trip sessions, trip charges, one-time codes, wallet
  ledger, PIN/code-guess fraud tracking. Run this first.
- `zira_go_telegram_schema.sql` — `telegram_chat_id` on students/drivers, and
  the `telegram_link_codes` table both sides share.
- `zira_go_auth_bank_schema.sql` — login credentials, bank account columns,
  the `admins` table, and `bank_account_change_requests`.

Run all three, in that order, against your existing ZiraPay database. They're
all `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE` — safe to run once, and safe
to re-run (they won't error on already-applied changes).

### Backend (Node/Express)
- `zira_go_trip_routes.js` — start a trip, charge a passenger (reg-no+PIN or
  one-time code), close a trip. Fires Telegram notifications on success and
  on a driver getting flagged.
- `zira_go_auth_routes.js` — register/login for students and drivers, admin
  login, the `requireAuth`/`requireRole` middleware everything else uses.
- `zira_go_bank_routes.js` — verify a bank account once (locks it), submit a
  change request against a locked account, and the admin-only approve/reject
  queue. **`resolveBankAccount()` is a stub** — see "Stubs you must wire up."
- `zira_go_telegram_link_routes.js` — generates the link code the web app
  shows (`zira_go_account.html`), into the same table the bot reads from.
- `zira_go_telegram_bot.js` — the actual Telegram bot process: `/start
  <code>` to link (student or driver, same flow), `/code` for students to
  pull a ride code without opening the app, and the `notifyStudent` /
  `notifyDriver` / `notifyDriverFlagged` push helpers.
- `server.js` — example wiring showing how all the route files above mount
  onto one Express app and one shared `pg.Pool`. **Merge this into your real
  server, don't run it standalone** — it doesn't have your existing
  CORS/session/logging middleware.
- `package.json` — the new dependencies this bundle adds
  (`bcrypt`, `jsonwebtoken`, `node-telegram-bot-api`) on top of whatever
  ZiraPay's backend already has.

### Frontend (static HTML, no build step)
- `zira_go_login.html` — one page, role toggle (Student/Driver), tabs for
  sign-in vs. create-account. Posts to `/api/auth/*`, stores the JWT in
  `localStorage`, redirects into the matching app.
- `zira_go_driver_panel.html` — the driver-side trip/charging UI (from the
  earlier build). Now auth-gated, sends the stored token on every request,
  and has a header link into `zira_go_account.html`.
- `zira_go_student_wallet.html` — the student wallet UI (fund, get ride
  code, set PIN, history). Same auth-gate treatment, plus an "Account &
  bank" tile in the action grid.
- `zira_go_account.html` — new. Shared by both roles: generate a Telegram
  link code + deep link, and the bank-account verify/lock/change-request
  flow. Reads `zira_role` from `localStorage` to know which one it's showing.

All four HTML files use the same purple/violet dark theme already
established for Zira Go (`#120A24` background, `#8B5CF6`/`#B79CFB` accent
gradient, Sora + Inter). They're drop-in siblings — put them in the same
folder and the relative links between them (`zira_go_login.html`,
`zira_go_account.html`, etc.) just work.

## How the pieces connect

```
Student/Driver opens the app
        │
        ▼
zira_go_login.html  ──POST /api/auth/login or /register/*──▶  zira_go_auth_routes.js
        │  (stores JWT + role in localStorage)
        ▼
zira_go_student_wallet.html  /  zira_go_driver_panel.html
        │  every API call now sends Authorization: Bearer <token>
        ▼
zira_go_trip_routes.js  (charges) ──▶  zira_go_telegram_bot.js (pushes)
        │
        ▼
zira_go_account.html  ──▶  zira_go_telegram_link_routes.js (link code)
                       ──▶  zira_go_bank_routes.js (verify / change-request)
```

Admins never touch the student/driver apps — `zira_go_bank_routes.js`'s
`adminRouter` is meant to sit behind whatever internal admin dashboard
ZiraPay already has (the same one that handles marketplace/escrow/brand
approvals, per what's already built). Mount it there and gate it with
`requireRole('admin')`.

## Deploying

1. Copy the three `.sql` files' contents into your migration tool (or run
   them directly with `psql`) against the ZiraPay database, in the order
   listed above.
2. Copy the `.js` files into your existing ZiraPay backend repo (same
   folder as your other route files). Merge `server.js`'s wiring into your
   real entry point rather than replacing it.
3. `npm install bcrypt jsonwebtoken node-telegram-bot-api` (pg and express
   you already have).
4. Set environment variables (see below).
5. Copy the four `.html` files onto your Contabo VPS alongside your other
   static assets, or serve them via `express.static` as `server.js` shows.
   Reference PM2/Nginx setup you're already using for ZionBites/ZiraPay.
6. In each HTML file, replace `API_BASE` / the bot username placeholder with
   your real values, and flip `DEMO_MODE` to `false` once the backend is live.

## Environment variables you need to set

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | everything backend-side | your existing Postgres connection string |
| `JWT_SECRET` | `zira_go_auth_routes.js` | long random string; auth_routes.js **throws on boot** if this is missing, on purpose — no insecure default |
| `TELEGRAM_BOT_TOKEN` | `zira_go_telegram_bot.js` | from @BotFather |
| `PAYSTACK_SECRET_KEY` (or your Korapay equivalent) | `zira_go_bank_routes.js` | for the real `resolveBankAccount()` call — see below |

## Stubs you must wire up (can't be done without your credentials)

1. **`resolveBankAccount()` in `zira_go_bank_routes.js`** — currently
   throws. It needs a real call to whatever ZiraPay's funding flow already
   uses for Korapay (or Paystack's `/bank/resolve`) to look up the account
   holder's name from an account number + bank code. The commented-out code
   right above the stub shows the Paystack shape; swap in Korapay's
   equivalent if that's what you're already using for wallet funding. This
   is the one thing that makes bank verification real rather than
   decorative — without it, `/api/bank/verify` will 422 on every attempt.
2. **`BOT_USERNAME` in `zira_go_account.html`** — currently `'ZiraGoBot'`,
   a placeholder. Set it to your actual bot's `@username` so the "Open in
   Telegram" deep link on the account page goes to the right bot.
3. **`API_BASE` in each HTML file** — all four currently point at either a
   relative `/api/...` path or an `https://your-api.example.com` placeholder.
   Point them at your real deployed domain.
4. **Admin accounts** — the `admins` table has no seed data. Insert your
   first admin manually (`bcrypt.hash()` the password the same way
   `zira_go_auth_routes.js` does, at 12 rounds) since there's intentionally
   no public admin-signup endpoint.

## What this bundle does NOT include

*(Note: this section is from an earlier build stage and hasn't been kept
fully in sync with the app — for instance the admin dashboard UI and driver
withdrawal endpoint it describes as missing now exist. Password reset and
the driver-approval queue, called out as missing below, were added on
2026-09-26; see the Operations Desk change timeline in the admin panel for
the full history.)*

Being upfront about scope, since "complete ecosystem" covers a lot of
ground:

- **An admin dashboard UI.** The admin approve/reject endpoints exist
  (`zira_go_bank_routes.js`'s `adminRouter`), but there's no HTML screen for
  them yet — the plan above is to fold them into ZiraPay's existing admin
  panel rather than build a parallel one.
- **Real wallet funding/withdrawal wiring in the student wallet UI** — the
  fund/code/PIN flows in `zira_go_student_wallet.html` are still the demo
  versions from the earlier build. Per what's already live, ZiraPay's real
  Korapay funding-by-polling flow should replace `submitFunding()` once
  this file is merged into the real app rather than run standalone.
- ~~**Rate limiting, refresh tokens, password reset, or 2FA** on the auth
  routes~~ — rate limiting and password reset are now in place
  (`/api/auth/forgot-password` + `/api/auth/reset-password`, plus a new
  driver approval queue so new driver accounts can't take trips or withdraw
  until an admin reviews them). Refresh tokens / shorter-lived access
  tokens and 2FA for regular (non-admin) accounts are still open — see the
  checklist above.
- **A driver-side bank withdrawal flow** — verification/locking is here;
  the actual "move money out" endpoint isn't, since ZiraPay likely already
  has one for the wallet generally and this should reuse it rather than
  duplicate it.

Happy to build any of those next — just say which.
