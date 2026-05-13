# VRM Agent — Architecture Document v0.2

**Version 0.2 | April 2026**
**Status: Validated — Ready for development**

| Document | Architecture_v0.2.docx |
|---|---|
| Based on PRD | VRM Agent PRD v0.3 — All Pillars Validated |
| Previous version | Architecture_v0.1.docx — QA corrections applied |
| Target Market | Florida — US vacation rental managers |
| Build Approach | MVP — single manager, SaaS-ready foundation |

---

# 1. Tech Stack Decision

## 1.1 Frontend Framework

Framework: Next.js (React)

*Justification: Handles routing, SSR, and static pages in one framework; deploys to Vercel in one command; the most widely documented React framework with the largest hiring pool.*

## 1.2 Backend Framework

Framework: Node.js + Express (standalone API server)

*Justification: A dedicated always-on process is required for the async job worker, the pg-boss scheduler, webhook handling, and AI calls — none of which belong inside Next.js API routes.*

## 1.3 Language

Language: TypeScript throughout — frontend and backend

*Justification: Catches schema mismatches at compile time, which matters when every feature touches 5+ database tables across a multi-tenant system, and supports a growing engineering team without codebase chaos.*

---

# 2. Database

## 2.1 Database Engine

Database: PostgreSQL

*Justification: The PRD requires UUIDs, enums, text[] arrays, partial unique indexes, and database triggers — all native to Postgres and unsupported or awkward in alternatives.*

## 2.2 Hosting Provider

Provider: Supabase (managed PostgreSQL)

*Justification: Instant provisioning, built-in Row Level Security enforcement, web-based table editor for early debugging, and compatible with any standard Postgres tooling with no vendor lock-in.*

## 2.3 ORM

ORM: Prisma

*Justification: TypeScript-first, generates typed query builders from the schema, handles migrations cleanly, and is the standard choice for solo and small-team Node.js projects.*

## 2.4 Connection Configuration — Critical

**Required:** Prisma connects via Supabase's Session Mode pooler URL with `connection_limit=1` and `pgbouncer=true` in the connection string. This is the mandatory configuration to prevent the known Prisma + PgBouncer transaction mode incompatibility that causes random query failures under load. Using the wrong connection string will cause silent production failures.

## 2.5 Row Level Security

Supabase RLS is enabled on all tables. Every policy enforces `account_id = auth.uid()` at the database layer. This is the second line of defense behind the application-layer account isolation middleware — so even if application code contains a bug, the database rejects cross-account queries entirely.

## 2.6 Encryption at Rest

Sensitive columns are encrypted at the application layer using AES-256-GCM before writing to the database, and decrypted transparently on read via Prisma middleware. The master encryption key is stored in a Railway environment variable and never persists in the database.

Columns encrypted at minimum:
- `accounts.airbnb_access_token`
- `accounts.airbnb_refresh_token`
- `accounts.vrbo_access_token`
- `accounts.vrbo_refresh_token`
- `properties.wifi_password`
- `properties.door_access_instructions`

## 2.7 Schema Additions Required Beyond PRD v0.3

The following fields must be added to the PRD schema before development begins. All are additive — no existing table structures are changed.

| Table | Field | Type | Purpose |
|---|---|---|---|
| accounts | airbnb_access_token | text (encrypted) | Airbnb OAuth |
| accounts | airbnb_refresh_token | text (encrypted) | Airbnb token refresh |
| accounts | vrbo_access_token | text (encrypted) | VRBO OAuth |
| accounts | vrbo_refresh_token | text (encrypted) | VRBO token refresh |
| accounts | token_version | integer, default 1 | JWT session revocation |
| accounts | daily_ai_token_usage | integer, default 0 | AI cost control counter |
| accounts | ai_token_daily_cap | integer, default 500000 | AI cost ceiling |
| accounts | ai_token_cap_reset_at | timestamptz | Daily cap reset tracking |
| accounts | data_region | text, default 'us' | Future data residency |
| accounts | password_reset_token | text, nullable | Password reset — stores bcrypt hash of token |
| accounts | password_reset_expires_at | timestamptz, nullable | Password reset — 1-hour expiry timestamp |

---

# 3. Hosting & Infrastructure

## 3.1 Frontend Hosting

Platform: Vercel

*Justification: Zero-config Next.js deployment, automatic HTTPS, instant preview URLs per branch, and global CDN edge caching.*

## 3.2 Backend / API Hosting

Platform: Railway — single service running two processes: the Express API and the pg-boss worker.

*Justification: Runs a persistent Node.js process required for the async worker and scheduler; simple environment variable management; deploys from GitHub with automatic redeploys on push.*

## 3.3 Async Job Queue and Scheduler — pg-boss

Tool: pg-boss — a Postgres-native job queue running inside the backend service using the existing Supabase database. pg-boss replaces both node-cron and any need for separate queue infrastructure. It solves two critical architectural problems simultaneously:

**Webhook processing:** The webhook handler validates the signature, inserts the deduplication record, enqueues a job, and returns HTTP 200 immediately — typically under 100ms. The AI call, platform API send, and all downstream logic run asynchronously in the worker. Airbnb and VRBO never time out. No webhook is ever lost.

**Scheduled jobs:** pg-boss uses Postgres-level advisory locks to guarantee each scheduled job executes on exactly one worker at a time, regardless of how many Railway instances are running. Horizontal scaling never produces duplicate messages to guests or cleaners.

### Scheduled Jobs Registered at Service Startup

| Job Name | Schedule | PRD Reference |
|---|---|---|
| checkin-message-sweep | Every hour | Section 6.5 |
| checkout-reminder-sweep | Every hour | Section 6.6 |
| review-request-sweep | Every hour | Section 6.8 |
| cleaner-no-response-check | Every hour | Section 7 |
| pre-checkin-alert-check | Every hour | Section 7.4 |
| checkout-detection-sweep | Every hour | Section 7.2 path B |
| booking-activation-sweep | Every hour | Section 6.10 (Feature 1.6) |
| booking-sync-sweep | Every hour | Section 6.11 (Feature 1.7 fallback) |
| ai-token-cap-reset | Daily at 00:00 ET | Section 4 Rule 6 |
| guest-pii-retention-purge | Daily at 03:00 ET | Section 9 — GDPR / CCPA |

## 3.4 Environment Variable Strategy

- `.env` file locally for development — never committed to the repository
- Railway environment variables for the backend — all API keys, secrets, and the AES encryption key
- Vercel environment variables for the frontend — public API base URL only
- `.env.example` documents every required key with no values — safe to commit
- No secret is ever logged, returned in an API response, or included in an error message
- `AIRBNB_WEBHOOK_SECRET` — shared secret used for HMAC signature verification on all Airbnb webhook requests; stored in Railway environment variables
- `VRBO_WEBHOOK_SECRET` — shared secret used for HMAC signature verification on all VRBO webhook requests; stored in Railway environment variables

---

# 4. Authentication

## 4.1 Manager Login Method for MVP

Method: Email + password for the single manager account.

*Justification: One user, one account at MVP — no OAuth or SSO complexity is needed yet. The architecture is structured to support multi-tenant login when the SaaS layer is added post-MVP.*

## 4.2 Session Management

Sessions are managed via JWT tokens stored in an HTTP-only, Secure, SameSite=Strict cookie. Tokens are issued on successful login and validated via Express middleware on every protected route.

**Security:** HTTP-only cookies are inaccessible to JavaScript and cannot be stolen by XSS attacks. SameSite=Strict prevents CSRF. Secure ensures the cookie is never transmitted over plain HTTP.

## 4.3 JWT Revocation — Token Versioning

A `token_version` integer column is added to the accounts table (see Section 2.7). The current version is embedded in the JWT payload at issuance. On every authenticated request, middleware verifies the token version matches the current database value. To invalidate all active sessions — on forced logout, password reset, or security incident — the server increments `token_version`. All existing tokens become invalid immediately. This adds one lightweight database read per request.

## 4.4 CORS Policy

Express is configured to explicitly allowlist only the Vercel production domain and `localhost:3000` for development. All other origins are rejected. This prevents third-party websites from making authenticated API calls on behalf of authenticated users.

## 4.5 Password Reset Flow

Two columns are added to the accounts table (see Section 2.7): `password_reset_token` (text, nullable) stores the bcrypt hash of the reset token; `password_reset_expires_at` (timestamptz, nullable) stores the 1-hour expiry timestamp.

**POST /auth/forgot-password**

Generates a cryptographically random token, stores its bcrypt hash in `password_reset_token` with a 1-hour expiry in `password_reset_expires_at`, and sends a reset link to the manager's email address via SendGrid. The plaintext token is never stored.

**POST /auth/reset-password**

Validates the submitted token against the stored bcrypt hash, checks that `password_reset_expires_at` has not passed, updates the password hash, clears both `password_reset_token` and `password_reset_expires_at`, and increments `token_version` to immediately invalidate all active sessions. Both endpoints are rate-limited under the POST /auth/login bucket (10 requests per 15 minutes per IP).

---

# 5. AI Model Selection

## 5.1 Selected Model

Model: Claude Sonnet 4 via the Anthropic API

API model string: `claude-sonnet-4-20250514`

## 5.2 Justification — Cost, Quality, and Speed

Claude Sonnet 4 leads the market on strict multi-rule instruction-following — critical for the No Fabrication rule and the ESCALATE / URGENT_ESCALATE / MAINTENANCE response routing defined in PRD Section 6.3. It operates at approximately $3 per million input tokens with sub-3-second response times, making it cost-effective at MVP message volumes.

## 5.3 Timeout and Cost Controls

- Every AI API call has a hard 10-second timeout
- On timeout: falls back to the PRD-defined failure path — ESCALATE for guest messages, truncated raw description for work order summaries, `ai_failed = true` for review drafts
- A `daily_ai_token_usage` counter and `ai_token_daily_cap` limit are stored in the accounts table (Section 2.7)
- Before every AI call, the worker checks whether the daily cap has been reached
- If the cap is reached: message routes automatically to ESCALATE and the manager receives an alert
- The counter resets daily via the pg-boss `ai-token-cap-reset` job (Section 3.3)
- This prevents runaway costs from bugs, abuse, or platform webhook floods

## 5.4 System Prompt Construction

A `buildSystemPrompt(account, property, booking)` function fetches the three relevant database rows and interpolates every bracketed value from the PRD Section 6.2 template at runtime. No value is hardcoded. The same interpolation pattern applies to the AI summary prompt (Section 8.2) and both positive and negative review response prompts (Section 8.3).

**Execution context:** The system prompt is constructed inside the async pg-boss worker — never in the webhook handler. This ensures the HTTP 200 response to Airbnb and VRBO is returned before any database lookups or AI calls begin.

## 5.5 AI Data Privacy — Launch Prerequisite

The AI system prompt (PRD Section 6.2) transmits sensitive guest and property data to the Anthropic API — including `wifi_password`, `door_access_instructions`, guest PII, and booking dates. These fields are encrypted at rest (Section 2.6) but are decrypted and sent in plaintext to the AI provider. The following actions are required before launch:

- (1) Verify that the Anthropic API data processing agreement covers this use case.
- (2) Confirm that API inputs are not used for model training under the applicable terms.
- (3) Document Anthropic as a data processor in VRM Agent's Terms of Service and Privacy Policy.

**Launch prerequisite:** This is not a post-launch item. None of the above may be deferred. Transmitting guest PII to a third-party AI provider without the correct legal agreements in place creates direct regulatory exposure under GDPR, CCPA, and LGPD.

---

# 6. API Structure

## 6.1 Account Isolation Middleware

Every authenticated Express route passes through an `enforceAccountIsolation` middleware that reads `account_id` from the verified JWT session and appends it to every database query automatically. The client never passes `account_id` in a request body or query parameter — the server always derives it from the authenticated session. Supabase RLS at the database layer provides a second line of defense: a query missing the account filter at the application layer is still rejected by the database.

## 6.2 Rate Limiting

Rate limiting applied via `express-rate-limit` middleware per route group:

| Route Group | Limit |
|---|---|
| POST /auth/login │ POST /auth/forgot-password │ POST /auth/reset-password | 10 requests per 15 minutes per IP |
| POST /webhooks/* | 100 requests per minute per IP |
| GET │ PATCH /api/* | 300 requests per minute per authenticated session |

## 6.3 Webhook Endpoints

All webhook endpoints validate the platform signature before any processing. A job is enqueued via pg-boss and HTTP 200 is returned immediately. No business logic runs in the webhook handler itself.

| Method | Path | Source |
|---|---|---|
| POST | /webhooks/airbnb/message | Airbnb guest messages |
| POST | /webhooks/vrbo/message | VRBO guest messages |
| POST | /webhooks/airbnb/review | Airbnb review events |
| POST | /webhooks/vrbo/review | VRBO review events |
| POST | /webhooks/twilio/sms | Cleaner SMS replies |
| POST | /webhooks/airbnb/booking | Airbnb booking creation, modification, and cancellation events |
| POST | /webhooks/vrbo/booking | VRBO booking creation, modification, and cancellation events |
| POST | /webhooks/airbnb/checkout | Airbnb checkout events — triggers Feature 2.1 Trigger A for cleaning dispatch |
| POST | /webhooks/vrbo/checkout | VRBO checkout events — same purpose as Airbnb checkout webhook |

## 6.4 Internal Dashboard API Routes

All routes are JWT-protected with account isolation enforced on every query.

| Method | Path | Purpose |
|---|---|---|
| POST | /auth/login | Manager login |
| POST | /auth/logout | Invalidate session — increment token_version |
| POST | /auth/forgot-password | Generate reset token; send reset link via SendGrid |
| POST | /auth/reset-password | Validate token, update password, increment token_version |
| GET | /api/properties | List all properties |
| POST | /api/properties | Create new property + blank turnover_checklists row in a single transaction |
| PATCH | /api/properties/:id | Update property fields + turnover_checklists.checklist_body |
| GET | /api/bookings | Bookings with message send status |
| GET | /api/messages | Message log with status filters |
| PATCH | /api/messages/:id | Send manager reply via platform API; inserts outbound messages row (sender='manager', status='manager_handled'); updates source escalated message status |
| GET | /api/cleaning-jobs | Turnover status panel data |
| GET | /api/work-orders | Open and resolved work orders |
| PATCH | /api/work-orders/:id | Status updates, priority override, notes |
| POST | /api/work-orders | Trigger B: manager-initiated from damage FYI |
| PATCH | /api/cleaning-jobs/:id/dismiss-damage | Dismiss damage FYI report |
| GET | /api/review-drafts | Pending and resolved review drafts |
| PATCH | /api/review-drafts/:id | Mark draft as copied or dismissed |
| POST | /api/review-drafts/:id/retry | Retry failed AI draft generation |
| POST | /api/cleaners | Add cleaner to account roster; validates phone in E.164 format at save |
| PATCH | /api/cleaners/:id | Edit cleaner fields or deactivate; deactivation includes cascade check against property_cleaners before executing |
| PATCH | /api/settings | Update accounts fields: business_name, manager_phone, manager_email, alert_channel, communication_tone; optionally clears OAuth tokens on platform disconnect with token_version increment |
| GET | /api/account | Return accounts row for authenticated session |
| GET | /api/search?q=[query] | JWT-protected global search across bookings (guest_first_name, guest_last_name, platform_booking_id) and properties (name). Returns array of {type, id, display_name, url}. Max query length 100 characters. Rate-limited under GET │ PATCH /api/* bucket. |

## 6.5 Twilio SMS Integration

Official Twilio Node.js SDK. Outbound messages sent via `client.messages.create()`. Every inbound webhook request validated via `twilio.validateRequest()` using `TWILIO_AUTH_TOKEN` and the full request URL and parameters before any job is enqueued. Requests failing signature validation are rejected with HTTP 403.

---

# 7. Third-Party Integrations

## 7.1 Airbnb OAuth

Flow: OAuth 2.0 authorization code flow via the Airbnb developer platform.

- `access_token` and `refresh_token` stored encrypted in the accounts table (fields defined in Section 2.7)
- Token refresh executed automatically before any outbound Airbnb API call
- Refresh failure triggers a manager alert and halts processing for that account until resolved

## 7.2 VRBO OAuth

Flow: OAuth 2.0 authorization code flow via the Expedia Group / VRBO developer platform.

- Same encrypted token storage and automatic refresh strategy as Airbnb
- Stored in accounts table under `vrbo_access_token` and `vrbo_refresh_token`

## 7.3 Twilio

- Configured via `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` environment variables
- Per-account send number stored in `accounts.twilio_phone_number` per PRD schema
- Inbound webhook signature verified on every request before any job is enqueued

## 7.4 SendGrid (Email)

- Package: `@sendgrid/mail` npm package
- Configured via `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL` environment variables
- Used when `accounts.alert_channel = 'email'` or `'both'`; also used for password reset emails (Section 4.5)

## 7.5 Known SaaS Scaling Constraint — Shared Messaging Accounts

**V2 flag:** For MVP, all customers share one Twilio account and one SendGrid account. This creates a shared-fate risk: if one customer's activity triggers a spam flag or account suspension, all customers lose messaging capability simultaneously. The V2 remediation is Twilio sub-accounts per customer and per-account SendGrid sender identities. This constraint must not be forgotten at SaaS launch.

---

# 8. Error Handling & Logging Strategy

## 8.1 Error Catching

try/catch wraps all async functions in both the Express API and the pg-boss worker. Unhandled promise rejections and uncaught exceptions are caught at the process level, logged with full context, and reported to Sentry before any process crash.

## 8.2 Structured Logger — pino

Tool: pino — structured JSON logging with minimal performance overhead. Writes to stdout. Railway captures stdout automatically with no additional configuration required.

**Log levels in use:**
- `error` — exceptions, send failures, failed retries
- `warn` — retries, deduplication discards, orphaned webhooks, AI cap alerts
- `info` — job started/completed, messages sent, webhooks received
- `debug` — prompt construction, raw API responses — disabled in production

## 8.3 Error Tracking — Sentry

Tool: Sentry — catches and groups unhandled exceptions across the Express API and the pg-boss worker, with full stack traces, request context, and account metadata on every event. Free tier is sufficient for MVP.

*Justification: Structured error grouping and stack traces make debugging production incidents orders of magnitude faster than scrolling raw Railway logs.*

## 8.4 Log Aggregation — Logtail

Tool: Logtail (or Axiom) — ingests pino structured JSON from Railway. Provides searchable log history, filtering by account/property/job type, and retention well beyond Railway's 30-day window. Under $20/month at MVP scale.

## 8.5 Alerting Strategy

| Failure Event | Alert Method |
|---|---|
| Rule 3 message send failure | SMS to manager per PRD Rule 3 specification |
| Scheduler / worker job exception | Sentry alert to engineering team |
| Railway service crash | Railway built-in email alert on process exit |
| AI token daily cap reached | In-app alert + SMS to manager |
| Airbnb / VRBO token refresh failure | SMS to manager + account processing halted |

---

# 9. Security Considerations

## 9.1 Webhook Signature Verification

- **Twilio:** `twilio.validateRequest()` on every `/webhooks/twilio/sms` request — rejects anything without a valid `X-Twilio-Signature` before the job is enqueued. Invalid requests return HTTP 403.
- **Airbnb:** HMAC signature verification using `AIRBNB_WEBHOOK_SECRET` per Airbnb's published webhook security specification, implemented as Express middleware. The webhook handler is never reached if verification fails.
- **VRBO:** HMAC signature verification using `VRBO_WEBHOOK_SECRET` per the Expedia Group / VRBO webhook security specification, using the same Express middleware pattern. Both secrets are stored exclusively in Railway environment variables (see Section 3.4).

## 9.2 Secrets Management

- All API keys, OAuth credentials, the AES-256-GCM master encryption key, the JWT signing secret, `AIRBNB_WEBHOOK_SECRET`, and `VRBO_WEBHOOK_SECRET` stored exclusively in Railway and Vercel environment variables
- `.env.example` documents required variable names with no values — safe to commit to the repository
- `.gitignore` covers `.env` — never committed under any circumstance
- No secret is ever logged, included in an error message, or returned in any API response

## 9.3 Data Protection Layers

| Layer | Protection |
|---|---|
| Transport | All traffic over HTTPS — enforced by Vercel and Railway; plain HTTP connections rejected |
| Database connection | Postgres connection over SSL (sslmode=require) |
| Sensitive columns | AES-256-GCM application-layer encryption before database write; transparent decrypt on read via Prisma middleware |
| Database queries | Supabase RLS enforces account_id isolation at the database layer on every query |
| Session token | JWT in HTTP-only, Secure, SameSite=Strict cookie — inaccessible to JavaScript |
| Session revocation | token_version counter enables immediate full-session invalidation on any security event |
| API origin control | CORS allowlist restricts API access to known frontend origin only |
| URL parameters | No sensitive data ever passed in URL query parameters |

## 9.4 Guest PII and Privacy Compliance — GDPR / CCPA / LGPD

Guest first name, last name, platform user ID, message content, and booking dates are personal data under EU (GDPR), US California (CCPA), and Brazilian (LGPD) privacy law. This architecture implements the following controls:

- Daily automated retention purge job via pg-boss at 03:00 ET — deletes guest PII from bookings and messages rows where checkout_datetime is older than 12 months
- `data_region` field on the accounts table (Section 2.7) supports future geographic data residency requirements as the SaaS expands globally
- Terms of Service and Privacy Policy must document the data processor relationship with Airbnb, VRBO, and Anthropic — these legal documents are outside the scope of this architecture but are a launch prerequisite

---

# Appendix — PRD Open Questions Resolved by This Architecture

| Open Question (PRD Section 10) | Decision |
|---|---|
| Database / data store? | PostgreSQL on Supabase with RLS and application-layer AES-256-GCM encryption |
| Authentication method? | Email + password; JWT in HTTP-only cookie with token_version revocation; password reset via bcrypt-hashed token + SendGrid |
| Hosting platform? | Vercel (frontend) + Railway (backend + pg-boss worker) |
| AI model — Claude or GPT-4? | Claude Sonnet 4 (claude-sonnet-4-20250514) via Anthropic API; 10s timeout; per-account daily cap; data privacy review required before launch |
| Frontend framework? | Next.js (React) with TypeScript |
| How does the scheduler run? | pg-boss registered jobs — Postgres-locked, safe for horizontal scale, no duplicate fires |

---

*End of Architecture Document v0.2 — VRM Agent — April 2026*
