# VRM Agent — Feature Tickets v0.1

*Based on: PRD v0.4 · Architecture v0.2 · Screens v0.2*
*Total tickets: 62 · April 2026 · Validated*

## How to use these tickets in an AI-driven development session

When starting an AI development session, paste all four documents (PRD v0.4, Architecture v0.2, Screens v0.2, and this Tickets document) at the start of each session. Then say:

> "Your task for this session is [TICKET ID]: [TITLE]. Complete only this ticket. Do not proceed to the next ticket. When done, confirm which acceptance criteria are met."

---

# INFRASTRUCTURE & SETUP (T-001 – T-022)

## T-001 — Project Scaffolding — Monorepo, Next.js Frontend, Express Backend

**PILLAR:** INFRA | **DEPENDS ON:** None

**CONTEXT:** Before any feature can be built, the monorepo structure, framework configurations, and environment variable scaffolding must exist. VRM Agent uses Next.js (React + TypeScript) for the frontend on Vercel and Node.js + Express (TypeScript) for the standalone API/worker backend on Railway (Architecture Sections 1.1, 1.2, 3.1, 3.2). Both packages live in one repository. This ticket creates the skeleton that all subsequent tickets build inside.

**TASK:** Create a monorepo with two directories at root: /frontend and /backend. In /backend: initialize a TypeScript project (tsconfig.json, package.json with dev/build/start scripts), install express, typescript, ts-node, @types/node, @types/express, dotenv. Create /backend/src/index.ts with a basic Express app that listens on PORT from environment (default 3000), registers express.json() middleware, and exposes GET /health returning {status:ok}. Create /backend/.env.example listing every required environment variable: DATABASE_URL, DIRECT_DATABASE_URL, JWT_SECRET, AES_KEY, AIRBNB_WEBHOOK_SECRET, VRBO_WEBHOOK_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, ANTHROPIC_API_KEY, SENTRY_DSN, FRONTEND_URL, PORT, NODE_ENV. Create a root .gitignore covering .env, node_modules, dist. In /frontend: scaffold a Next.js 14 app-router project with TypeScript and Tailwind CSS. Add /frontend/app/page.tsx that redirects to /login. Verify both packages compile without TypeScript errors.

**ACCEPTANCE CRITERIA:**
1. Repository has /frontend and /backend directories at root.
2. GET /health returns {status:ok} when backend starts.
3. /frontend builds without TypeScript or compilation errors.
4. /backend/.env.example lists all 15 environment variables.
5. .gitignore at root covers .env and node_modules.
6. tsconfig.json in /backend is strict-mode TypeScript.

**FILES:** /backend/src/index.ts, /backend/tsconfig.json, /backend/package.json, /backend/.env.example, .gitignore, /frontend/app/page.tsx, /frontend/tsconfig.json, /frontend/tailwind.config.ts, /frontend/package.json

---

## T-002 — Prisma + Supabase Database Connection Setup

**PILLAR:** INFRA | **DEPENDS ON:** T-001

**CONTEXT:** All VRM Agent data is stored in PostgreSQL on Supabase, accessed via Prisma ORM (Architecture Sections 2.1, 2.2, 2.3). The connection string is critical: Prisma must use Supabase's Session Mode pooler URL with connection_limit=1&pgbouncer=true appended (Architecture Section 2.4) to prevent the known Prisma + PgBouncer transaction-mode incompatibility that causes silent production failures. A DIRECT_DATABASE_URL (non-pooled) is used for migrations only.

**TASK:** Inside /backend, install prisma and @prisma/client. Run prisma init to create /backend/prisma/schema.prisma. Configure the datasource db block: provider = "postgresql", url = env("DATABASE_URL"), directUrl = env("DIRECT_DATABASE_URL"). Update .env.example to document DATABASE_URL as the Supabase Session Mode pooler URL that must include ?connection_limit=1&pgbouncer=true and DIRECT_DATABASE_URL as the direct connection URL used for migrations. Create /backend/src/lib/prisma.ts exporting a singleton PrismaClient instance using the standard global singleton pattern (store on global in development to survive hot-reload, instantiate once in production). Verify npx prisma validate passes.

**ACCEPTANCE CRITERIA:**
1. schema.prisma has datasource db with url and directUrl.
2. /backend/src/lib/prisma.ts exports a singleton PrismaClient.
3. npx prisma validate passes without errors.
4. .env.example documents DATABASE_URL with required format note including ?connection_limit=1&pgbouncer=true.
5. .env.example documents DIRECT_DATABASE_URL.
6. No PrismaClient is instantiated more than once per process.

**FILES:** /backend/prisma/schema.prisma, /backend/src/lib/prisma.ts, /backend/.env.example

---

## T-003 — DB Migration — accounts Table

**PILLAR:** INFRA | **DEPENDS ON:** T-002

**CONTEXT:** The accounts table is the root of the multi-tenant data model. Every other table has an account_id FK pointing here. This table stores the manager's profile, OAuth tokens, JWT revocation counter, AI usage tracking, alert preferences, and password-reset state. Fields come from PRD Section 5.1 plus all Architecture Section 2.7 additions.

**TASK:** Add the accounts model to /backend/prisma/schema.prisma with these exact fields: id (String @id @default(uuid())), business_name (String), manager_phone (String), manager_email (String), alert_channel (enum AlertChannel: sms, email, both), communication_tone (enum CommunicationTone: casual, professional, luxury), twilio_phone_number (String?), airbnb_access_token (String?), airbnb_refresh_token (String?), vrbo_access_token (String?), vrbo_refresh_token (String?), token_version (Int @default(1)), daily_ai_token_usage (Int @default(0)), ai_token_daily_cap (Int @default(500000)), ai_token_cap_reset_at (DateTime?), data_region (String @default("us")), password_hash (String), password_reset_token (String?), password_reset_expires_at (DateTime?), created_at (DateTime @default(now())). Define AlertChannel and CommunicationTone enums. Run npx prisma migrate dev --name create_accounts_table.

**ACCEPTANCE CRITERIA:**
1. accounts model in schema has all 20 fields.
2. AlertChannel enum: sms, email, both. CommunicationTone enum: casual, professional, luxury.
3. token_version defaults to 1; daily_ai_token_usage defaults to 0; ai_token_daily_cap defaults to 500000.
4. Migration SQL file generated in /backend/prisma/migrations/.
5. accounts table visible in Supabase table editor.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_accounts/migration.sql

---

## T-004 — DB Migration — properties Table

**PILLAR:** INFRA | **DEPENDS ON:** T-003

**CONTEXT:** The properties table stores all operational data the AI agent needs to answer guest questions and dispatch cleaners. property_status tracks the property's current operational state. All fields from PRD Section 5.2.

**TASK:** Add the properties model to schema.prisma with all fields from PRD Section 5.2: id, account_id (FK accounts), name, address, checkin_time, checkout_time, door_access_instructions (String?), parking_instructions (String?), wifi_name (String?), wifi_password (String?), house_rules (String?), amenities (String?), local_recommendations (String?), special_instructions (String?), checkout_steps (String?), checkin_message_template (String?), checkout_reminder_template (String?), review_request_template (String?), checkin_message_enabled (Boolean @default(true)), checkout_reminder_enabled (Boolean @default(true)), review_request_enabled (Boolean @default(true)), checkin_message_hours_before (Int @default(24)), checkout_reminder_send_time (String @default("20:00")), review_request_hours_after (Int @default(2)), airbnb_listing_id (String?), vrbo_listing_id (String?), property_status (enum PropertyStatus: unknown, guest_ready, occupied, needs_cleaning @default(unknown)), auto_schedule_cleaner_enabled (Boolean @default(true)), cleaner_confirmation_window_minutes (Int @default(60)), pre_checkin_alert_minutes (Int @default(30)), created_at. Define PropertyStatus enum. Run migration.

**ACCEPTANCE CRITERIA:**
1. properties model has all 31 fields with correct optionality.
2. PropertyStatus enum has all 4 values with unknown as default.
3. All 3 boolean message-enabled fields default to true.
4. account_id @relation to accounts.id defined.
5. Migration applied; properties table visible in Supabase.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_properties/migration.sql

---

## T-005 — DB Migration — bookings Table

**PILLAR:** INFRA | **DEPENDS ON:** T-004

**CONTEXT:** The bookings table is the central record for every guest stay. It is populated exclusively by the booking-sync webhooks (Feature 1.7). A composite unique constraint on (account_id, platform, platform_booking_id) prevents duplicate booking rows. All fields from PRD Section 5.3.

**TASK:** Add the bookings model to schema.prisma with fields: id, account_id (FK accounts), property_id (FK properties), platform (enum Platform: airbnb, vrbo), platform_booking_id (String), guest_first_name, guest_last_name, guest_platform_id, checkin_datetime (DateTime), checkout_datetime (DateTime), status (enum BookingStatus: upcoming, active, completed, cancelled), checkin_message_sent (Boolean @default(false)), checkin_message_sent_at (DateTime?), checkout_reminder_sent (Boolean @default(false)), checkout_reminder_sent_at (DateTime?), review_request_sent (Boolean @default(false)), review_request_sent_at (DateTime?), created_at. Add @@unique([account_id, platform, platform_booking_id]). Define Platform and BookingStatus enums. Run migration.

**ACCEPTANCE CRITERIA:**
1. bookings model has all 18 fields.
2. Platform enum: airbnb, vrbo. BookingStatus enum: upcoming, active, completed, cancelled.
3. @@unique([account_id, platform, platform_booking_id]) constraint applied.
4. Inserting two rows with the same (account_id, platform, platform_booking_id) fails.
5. Migration applied; bookings table visible in Supabase.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_bookings/migration.sql

---

## T-006 — DB Migration — messages Table

**PILLAR:** INFRA | **DEPENDS ON:** T-005

**CONTEXT:** The messages table records every inbound and outbound guest communication. platform_message_id is globally UNIQUE and inserted immediately upon webhook receipt before any AI processing (PRD Rule 4 deduplication). The is_urgent boolean enables dashboard color-coding. All fields from PRD Section 5.4.

**TASK:** Add the messages model to schema.prisma with fields: id, account_id (FK accounts), property_id (FK properties), booking_id (FK bookings), platform_message_id (String @unique), direction (enum MessageDirection: inbound, outbound), channel (enum MessageChannel: airbnb, vrbo, sms), sender (enum MessageSender: guest, agent, manager), content (String), intent_classification (String?), status (enum MessageStatus: auto_handled, escalated, failed, no_response_needed, processing, manager_handled), is_urgent (Boolean @default(false)), escalation_reason (String?), maintenance_triggered (Boolean @default(false)), sent_at (DateTime?), created_at. Define all 4 enum types. Run migration.

**ACCEPTANCE CRITERIA:**
1. messages model has all 16 fields.
2. platform_message_id is @unique.
3. is_urgent field exists with @default(false).
4. MessageStatus enum includes all 6 values: auto_handled, escalated, failed, no_response_needed, processing, manager_handled.
5. Migration applied; messages table visible in Supabase.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_messages/migration.sql

---

## T-007 — DB Migration — cleaners + property_cleaners Tables

**PILLAR:** INFRA | **DEPENDS ON:** T-004

**CONTEXT:** The cleaners table stores the account-level roster of cleaning staff. The property_cleaners junction table assigns cleaners to properties, with exactly one primary cleaner per property enforced by the partial unique index property_cleaners_one_primary_per_property. This index cannot be expressed in Prisma schema syntax and must be applied as raw SQL. Fields from PRD Sections 5.6 and 5.7.

**TASK:** Add cleaners model: id (uuid pk), account_id (FK accounts), name (String), phone (String), email (String?), is_active (Boolean @default(true)), created_at. Add property_cleaners model: id, account_id (FK accounts), property_id (FK properties), cleaner_id (FK cleaners), is_primary (Boolean @default(false)), created_at. Run prisma migrate dev. Then apply via raw SQL: CREATE UNIQUE INDEX property_cleaners_one_primary_per_property ON property_cleaners (property_id) WHERE is_primary = true. Document this SQL in /backend/prisma/migrations/[timestamp]_cleaners_partial_index/migration.sql.

**ACCEPTANCE CRITERIA:**
1. cleaners model has all 7 fields.
2. property_cleaners model has all 6 fields.
3. Partial unique index property_cleaners_one_primary_per_property exists in Supabase.
4. Inserting a second row with is_primary = true for the same property_id fails with a unique constraint violation.
5. Migration files generated and applied.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_cleaners/migration.sql, /backend/prisma/migrations/[timestamp]_cleaners_partial_index/migration.sql

---

## T-008 — DB Migration — turnover_checklists Table + updated_at Trigger

**PILLAR:** INFRA | **DEPENDS ON:** T-004

**CONTEXT:** The turnover_checklists table stores the room-by-room cleaning checklist for each property (one row per property). The updated_at column is maintained by the shared set_updated_at() PostgreSQL trigger function. This trigger function is created here and reused in T-009 through T-011.

**TASK:** Add turnover_checklists model: id, account_id (FK accounts), property_id (FK properties), checklist_body (String @default("")), created_at, updated_at (DateTime @updatedAt). Run prisma migrate dev. Then apply raw SQL creating: (1) the shared trigger function: CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql; (2) the table trigger: CREATE TRIGGER turnover_checklists_updated_at BEFORE UPDATE ON turnover_checklists FOR EACH ROW EXECUTE FUNCTION set_updated_at(). Document in migration file.

**ACCEPTANCE CRITERIA:**
1. turnover_checklists model has all 6 fields.
2. set_updated_at() function exists in Supabase.
3. turnover_checklists_updated_at trigger fires on UPDATE.
4. updated_at changes on any UPDATE to a row (verify via Supabase SQL editor).
5. Migration applied.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_turnover_checklists/migration.sql, /backend/prisma/migrations/[timestamp]_turnover_checklists_trigger/migration.sql

---

## T-009 — DB Migration — cleaning_jobs Table + Trigger + UNIQUE Constraint

**PILLAR:** INFRA | **DEPENDS ON:** T-005, T-007, T-008

**CONTEXT:** The cleaning_jobs table tracks every turnover job dispatched to a cleaner. It has 28 fields including the booking_id UNIQUE constraint preventing duplicate cleaning jobs for the same checkout. The inbound_sms_sids text[] array enables Twilio MessageSid deduplication. The damage_fyi_sent flag means "damage detected" — not "FYI sent successfully". All fields from PRD Section 5.9.

**TASK:** Add cleaning_jobs model with all 28 fields from PRD Section 5.9: id, account_id, property_id, booking_id (FK bookings, @unique), next_booking_id (FK bookings, optional), cleaner_id (FK cleaners), status (enum CleaningJobStatus: scheduled, confirmed, completed, no_response, failed), scheduled_start (DateTime), deadline (DateTime?), job_notification_sent (Boolean @default(false)), job_notification_sent_at (DateTime?), cleaner_confirmed_at (DateTime?), checklist_sent (Boolean @default(false)), checklist_sent_at (DateTime?), completed_at (DateTime?), closed_by (enum ClosedBy: cleaner_sms, manager_manual, optional), completion_sms_raw (String?), supply_flags (String[]), supply_alert_sent (Boolean @default(false)), supply_alert_sent_at (DateTime?), supply_alert_dismissed (Boolean @default(false)), supply_alert_permanently_failed (Boolean @default(false)), no_response_alert_sent (Boolean @default(false)), pre_checkin_alert_sent (Boolean @default(false)), damage_fyi_sent (Boolean @default(false)), damage_report_dismissed (Boolean @default(false)), inbound_sms_sids (String[] @default([])), created_at, updated_at (@updatedAt). Run migration. Apply cleaning_jobs_updated_at trigger via raw SQL per PRD Section 5.10.

**ACCEPTANCE CRITERIA:**
1. cleaning_jobs model has all 28 fields.
2. CleaningJobStatus enum: scheduled, confirmed, completed, no_response, failed.
3. booking_id is @unique — duplicate booking_id INSERT fails.
4. supply_flags and inbound_sms_sids are String[]; inbound_sms_sids defaults to {}.
5. cleaning_jobs_updated_at trigger fires on UPDATE.
6. Migration applied.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_cleaning_jobs/migration.sql

---

## T-010 — DB Migration — work_orders Table + Trigger + Partial Unique Index

**PILLAR:** INFRA | **DEPENDS ON:** T-005, T-009

**CONTEXT:** The work_orders table records every maintenance issue reported by guests, cleaners, or managers. The partial unique index work_orders_source_message_id_unique prevents duplicate work orders from the same guest message. Fields from PRD Section 5.5, constraints from PRD Section 5.11.

**TASK:** Add work_orders model: id, account_id (FK accounts), property_id (FK properties), booking_id (FK bookings, optional), reported_by (enum ReportedBy: guest, cleaner, manager), description (String), ai_summary (String?), priority (enum WorkOrderPriority: urgent, high, medium, low), status (enum WorkOrderStatus: open, in_progress, resolved), source_message_id (FK messages, optional), source_cleaning_job_id (FK cleaning_jobs, optional), resolved_at (DateTime?), resolved_by (enum ResolvedBy: manager, optional), manager_notes (String?), created_at, updated_at (@updatedAt). Run migration. Apply: CREATE TRIGGER work_orders_updated_at BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at() and CREATE UNIQUE INDEX work_orders_source_message_id_unique ON work_orders (source_message_id) WHERE source_message_id IS NOT NULL.

**ACCEPTANCE CRITERIA:**
1. work_orders model has all 16 fields.
2. WorkOrderPriority enum: urgent, high, medium, low. WorkOrderStatus enum: open, in_progress, resolved.
3. Partial unique index work_orders_source_message_id_unique exists.
4. Two work orders with the same non-null source_message_id -> constraint violation.
5. work_orders_updated_at trigger fires on UPDATE.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_work_orders/migration.sql

---

## T-011 — DB Migration — review_drafts Table + Trigger

**PILLAR:** INFRA | **DEPENDS ON:** T-004, T-005

**CONTEXT:** The review_drafts table stores AI-generated response drafts for reviews received via Airbnb and VRBO webhooks. platform_review_id is globally @unique for deduplication. no_review_text and ai_failed boolean flags drive conditional UI behavior in the Review Draft modal. booking_id is always NULL in MVP. Fields from PRD Section 5.12.

**TASK:** Add review_drafts model: id, account_id (FK accounts), property_id (FK properties), booking_id (FK bookings, optional — always NULL in MVP), platform (reuse Platform enum), platform_review_id (String @unique), reviewer_name (String), rating (Int), review_text (String?), draft_response (String?), status (enum ReviewDraftStatus: pending, copied, dismissed), no_review_text (Boolean @default(false)), ai_failed (Boolean @default(false)), created_at, updated_at (@updatedAt). Run migration. Apply: CREATE TRIGGER review_drafts_updated_at BEFORE UPDATE ON review_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at().

**ACCEPTANCE CRITERIA:**
1. review_drafts model has all 15 fields.
2. platform_review_id is @unique.
3. ReviewDraftStatus enum: pending, copied, dismissed.
4. review_drafts_updated_at trigger fires on UPDATE.
5. Migration applied; table visible in Supabase.

**FILES:** /backend/prisma/schema.prisma, /backend/prisma/migrations/[timestamp]_create_review_drafts/migration.sql

---

## T-012 — Supabase Row Level Security Policies — All Tables

**PILLAR:** INFRA | **DEPENDS ON:** T-011

**CONTEXT:** Supabase RLS is the second line of defense for account isolation — even if application code has a bug and omits the account_id filter, the database rejects cross-account queries at the database layer (Architecture Section 2.5). RLS must be enabled on all 11 tables.

**TASK:** Execute the following SQL for each of the 11 tables (accounts, properties, bookings, messages, cleaners, property_cleaners, turnover_checklists, cleaning_jobs, work_orders, review_drafts): ALTER TABLE [table] ENABLE ROW LEVEL SECURITY; CREATE POLICY [table]_account_isolation ON [table] FOR ALL USING (account_id = auth.uid()). For accounts specifically: CREATE POLICY accounts_isolation ON accounts FOR ALL USING (id = auth.uid()). Execute via Supabase SQL editor or as a Prisma raw SQL migration. Save all SQL in /backend/prisma/migrations/[timestamp]_rls_policies/migration.sql.

**ACCEPTANCE CRITERIA:**
1. RLS is enabled on all 11 tables.
2. Each table has a policy enforcing account_id = auth.uid() (or id = auth.uid() for accounts).
3. A query without a valid auth context returns 0 rows on any protected table.
4. All SQL documented in migration file.

**FILES:** /backend/prisma/migrations/[timestamp]_rls_policies/migration.sql

---

## T-013 — Application-Layer AES-256-GCM Encryption Prisma Middleware

**PILLAR:** INFRA | **DEPENDS ON:** T-002

**CONTEXT:** Six sensitive columns must be encrypted before writing to the database and decrypted transparently on read, per Architecture Section 2.6. The master AES-256-GCM key is stored in the AES_KEY environment variable (a 32-byte hex string). Encrypted columns: accounts.airbnb_access_token, accounts.airbnb_refresh_token, accounts.vrbo_access_token, accounts.vrbo_refresh_token, properties.wifi_password, properties.door_access_instructions.

**TASK:** Create /backend/src/lib/encryption.ts exporting encrypt(plaintext: string): string and decrypt(ciphertext: string): string using Node.js crypto with AES-256-GCM. encrypt() generates a random 12-byte IV per call and returns base64(iv_12bytes || authTag_16bytes || ciphertext). decrypt() parses that layout. Create /backend/src/lib/prismaEncryptionMiddleware.ts using prisma.$use() to intercept all create and update operations for accounts and properties, and all read operations for these models, encrypting/decrypting the specified fields. Register middleware in /backend/src/lib/prisma.ts. Write unit tests in encryption.test.ts.

**ACCEPTANCE CRITERIA:**
1. encrypt(decrypt(ciphertext)) returns original string (unit test passes).
2. Null/undefined field values pass through middleware unchanged.
3. After a properties INSERT, the raw wifi_password in Supabase is not plaintext.
4. After prisma.properties.findUnique(), returned wifi_password is the decrypted plaintext.
5. AES key is read from process.env.AES_KEY — never hardcoded.

**FILES:** /backend/src/lib/encryption.ts, /backend/src/lib/prismaEncryptionMiddleware.ts, /backend/src/lib/prisma.ts, /backend/src/lib/encryption.test.ts

---

## T-014 — pino Logging + Sentry Error Tracking Setup

**PILLAR:** INFRA | **DEPENDS ON:** T-001

**CONTEXT:** All backend logging uses pino (structured JSON, minimal overhead) per Architecture Section 8.2. Sentry catches and groups unhandled exceptions. Both tools must be wired before any business logic runs.

**TASK:** Install pino and pino-pretty in /backend. Create /backend/src/lib/logger.ts exporting a pino logger with level debug in development (NODE_ENV !== production) and info in production. Install @sentry/node. In /backend/src/index.ts: (1) call Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV }) before any Express setup; (2) register Sentry.Handlers.requestHandler() as the first middleware; (3) register Sentry.Handlers.errorHandler() as the last middleware before the generic error handler; (4) add process.on("unhandledRejection", ...) handler.

**ACCEPTANCE CRITERIA:**
1. logger.ts exports a pino logger instance.
2. Logger level is debug when NODE_ENV !== production, info when production.
3. Sentry.init() called before any route registration in index.ts.
4. Sentry.Handlers.requestHandler() is the first Express middleware.
5. Sentry.Handlers.errorHandler() is registered after all routes.
6. Unhandled promise rejection handler calls both logger.error and Sentry.captureException.

**FILES:** /backend/src/lib/logger.ts, /backend/src/index.ts, /backend/.env.example

---

## T-015 — pg-boss Worker Setup + All 10 Scheduled Job Registrations

**PILLAR:** INFRA | **DEPENDS ON:** T-002, T-014

**CONTEXT:** pg-boss is the Postgres-native job queue and scheduler that provides advisory locking to guarantee each scheduled job fires on exactly one worker even across multiple Railway instances (Architecture Section 3.3). All 10 scheduled jobs must be registered at startup.

**TASK:** Install pg-boss in /backend. Create /backend/src/worker.ts: (1) instantiate new PgBoss(process.env.DATABASE_URL); (2) call await boss.start(); (3) register all 10 jobs using boss.schedule(name, cron): checkin-message-sweep ("0 * * * *"), checkout-reminder-sweep ("0 * * * *"), review-request-sweep ("0 * * * *"), cleaner-no-response-check ("0 * * * *"), pre-checkin-alert-check ("0 * * * *"), checkout-detection-sweep ("0 * * * *"), booking-activation-sweep ("0 * * * *"), booking-sync-sweep ("0 * * * *"), ai-token-cap-reset ("0 5 * * *" = 00:00 ET), guest-pii-retention-purge ("0 8 * * *" = 03:00 ET); (4) register boss.work() stub handler for each job logging "Job [name] fired"; (5) handle boss.on("error") calling logger.error and Sentry.captureException. Add start:worker script to package.json.

**ACCEPTANCE CRITERIA:**
1. worker.ts runs without errors.
2. All 10 jobs registered with boss.schedule().
3. Each job has a boss.work() stub handler that logs when fired.
4. ai-token-cap-reset cron is "0 5 * * *".
5. boss.on("error") reports to Sentry.
6. start:worker script in package.json.

**FILES:** /backend/src/worker.ts, /backend/package.json

---

## T-016 — JWT Auth Middleware + token_version Revocation Check

**PILLAR:** INFRA | **DEPENDS ON:** T-003, T-015

**CONTEXT:** All authenticated routes require a valid JWT in an HTTP-only cookie named "token". The JWT payload contains account_id and token_version. The middleware verifies the signature, then performs a lightweight DB read to confirm token_version in the JWT matches accounts.token_version — if they differ, the session has been revoked (Architecture Sections 4.2, 4.3).

**TASK:** Install jsonwebtoken and cookie-parser in /backend. Add cookie-parser to /backend/src/index.ts before route registration. Create /backend/src/middleware/auth.ts exporting authenticateJWT: (1) read req.cookies.token — undefined -> 401; (2) jwt.verify(token, process.env.JWT_SECRET) — failure -> 401; (3) extract { account_id, token_version } from payload; (4) query prisma.accounts.findUnique for token_version; (5) if not found or token_version mismatch -> 401; (6) set req.account_id = account_id; (7) next(). Also export a protectedRouter() factory. Extend the Express Request type in /backend/src/types/express.d.ts to include account_id: string.

**ACCEPTANCE CRITERIA:**
1. Missing token cookie -> HTTP 401.
2. Invalid JWT signature -> HTTP 401.
3. Valid JWT but token_version mismatch in DB -> HTTP 401.
4. Valid JWT and matching token_version -> req.account_id set, next() called.
5. protectedRouter() factory exported from auth.ts.
6. TypeScript Request type extended with account_id.

**FILES:** /backend/src/middleware/auth.ts, /backend/src/types/express.d.ts, /backend/src/index.ts, /backend/.env.example

---

## T-017 — Account Isolation Middleware

**PILLAR:** INFRA | **DEPENDS ON:** T-016

**CONTEXT:** Every authenticated API route must filter database queries by the authenticated account_id from the JWT. The client never passes account_id in request bodies or query parameters (Architecture Section 6.1).

**TASK:** Create /backend/src/middleware/accountIsolation.ts exporting enforceAccountIsolation middleware: (1) set res.locals.account_id = req.account_id; (2) set res.locals.accountFilter = () => ({ account_id: req.account_id }); (3) call next(). Update protectedRouter() in auth.ts to also apply enforceAccountIsolation after authenticateJWT. Extend Express Response type in express.d.ts.

**ACCEPTANCE CRITERIA:**
1. enforceAccountIsolation sets res.locals.account_id and res.locals.accountFilter.
2. res.locals.accountFilter() returns { account_id: string }.
3. protectedRouter() applies both authenticateJWT and enforceAccountIsolation in sequence.
4. No async database calls in this middleware.
5. TypeScript Response.locals type extended correctly.

**FILES:** /backend/src/middleware/accountIsolation.ts, /backend/src/middleware/auth.ts, /backend/src/types/express.d.ts

---

## T-018 — Rate Limiting + CORS Middleware

**PILLAR:** INFRA | **DEPENDS ON:** T-001

**CONTEXT:** Three rate limiting buckets defined in Architecture Section 6.2. CORS must allowlist only the Vercel production domain and localhost:3000 with credentials: true required for the HTTP-only JWT cookie to work cross-origin.

**TASK:** Install express-rate-limit and cors in /backend. In index.ts add CORS middleware with allowlist. Create /backend/src/middleware/rateLimiting.ts exporting three limiters: authLimiter (windowMs: 15*60*1000, max: 10), webhookLimiter (windowMs: 60*1000, max: 100), apiLimiter (windowMs: 60*1000, max: 300). Apply authLimiter to all /auth/* routes, webhookLimiter to all /webhooks/* routes, apiLimiter to all /api/* routes. All limiters return HTTP 429 on breach.

**ACCEPTANCE CRITERIA:**
1. CORS allowlists FRONTEND_URL and localhost:3000 only; other origins rejected.
2. credentials: true set on CORS config.
3. POST /auth/login returns 429 after 10 requests in 15 minutes from the same IP.
4. Three rate limiter instances exported from rateLimiting.ts.
5. All /api/* routes use apiLimiter; /webhooks/* use webhookLimiter.

**FILES:** /backend/src/middleware/rateLimiting.ts, /backend/src/index.ts, /backend/.env.example

---

## T-019 — POST /auth/login + POST /auth/logout

**PILLAR:** INFRA | **DEPENDS ON:** T-016, T-018

**CONTEXT:** The manager authenticates with email + password. Login verifies the bcrypt hash, issues a JWT in an HTTP-only cookie. Logout increments token_version to immediately invalidate all active sessions and clears the cookie.

**TASK:** Install bcryptjs in /backend. Create /backend/src/routes/auth.ts. Implement POST /auth/login and POST /auth/logout (with token_version increment). Create /backend/src/scripts/seedAccount.ts inserting one test accounts row with bcrypt-hashed password "password". Register router with authLimiter.

**ACCEPTANCE CRITERIA:**
1. POST /auth/login with correct credentials returns 200 and sets HTTP-only token cookie.
2. POST /auth/login with wrong credentials -> 401 with "Incorrect email or password."
3. POST /auth/logout increments token_version in DB and clears token cookie.
4. JWT cookie has httpOnly: true, sameSite: "strict", secure: true in production.
5. Seed script creates test account; running it twice does not error.

**FILES:** /backend/src/routes/auth.ts, /backend/src/index.ts, /backend/src/scripts/seedAccount.ts

---

## T-020 — POST /auth/forgot-password

**PILLAR:** INFRA | **DEPENDS ON:** T-019

**CONTEXT:** The forgot-password flow generates a cryptographically random token, stores its bcrypt hash in accounts.password_reset_token with a 1-hour expiry, and emails a reset link via SendGrid. The same 200 response is returned whether or not the email exists to prevent account enumeration.

**TASK:** Install @sendgrid/mail in /backend. Implement POST /auth/forgot-password in auth.ts. Generate crypto.randomBytes(32) token, bcrypt hash it, store with 1-hour expiry, send reset link via SendGrid. Always return 200 with same message. Apply authLimiter.

**ACCEPTANCE CRITERIA:**
1. POST /auth/forgot-password always returns 200 with the same message regardless of whether email exists.
2. When email exists: password_reset_token (bcrypt hash) and password_reset_expires_at (1 hour) set in DB.
3. Plaintext token never stored in DB — only the bcrypt hash.
4. SendGrid sends email containing the plaintext token in the URL.
5. Endpoint is rate-limited by authLimiter.

**FILES:** /backend/src/routes/auth.ts, /backend/.env.example

---

## T-021 — POST /auth/reset-password

**PILLAR:** INFRA | **DEPENDS ON:** T-020

**CONTEXT:** The reset-password endpoint validates the submitted token against the bcrypt hash, checks expiry, updates password_hash, clears reset columns, and increments token_version to immediately invalidate all active sessions.

**TASK:** Implement POST /auth/reset-password in auth.ts. Validate token, check expiry, update password, clear reset columns, increment token_version — all in a single Prisma transaction. Create /frontend/app/reset-password/page.tsx reading token and email from URL params.

**ACCEPTANCE CRITERIA:**
1. Valid token + email -> updates password_hash, clears reset columns, increments token_version.
2. Invalid or expired token -> 400.
3. After successful reset, previous JWT is rejected (token_version mismatch).
4. All 3 changes happen in one DB transaction.
5. frontend/app/reset-password/page.tsx renders form reading token and email from URL query params.

**FILES:** /backend/src/routes/auth.ts, /frontend/app/reset-password/page.tsx

---

## T-022 — Webhook Endpoint Stubs — All 9 Routes with Signature Validation

**PILLAR:** INFRA | **DEPENDS ON:** T-015, T-018

**CONTEXT:** All 9 webhook routes must validate platform signatures, enqueue pg-boss jobs with the raw payload, and return HTTP 200 immediately. This pattern prevents Airbnb, VRBO, and Twilio from timing out. Twilio requires an XML response body. Invalid signatures return HTTP 403.

**TASK:** Install twilio in /backend. Create /backend/src/middleware/webhookAuth.ts with three middleware functions: validateAirbnbSignature (HMAC-SHA256 using AIRBNB_WEBHOOK_SECRET), validateVrboSignature (VRBO_WEBHOOK_SECRET), validateTwilioSignature (twilio.validateRequest()). Create /backend/src/routes/webhooks.ts registering all 9 routes. Airbnb/VRBO routes return 200 { received: true }. Twilio route returns HTTP 200 with Content-Type: text/xml body: <?xml version="1.0"?><Response/>. Use express.raw() on Airbnb/VRBO routes for HMAC computation.

**ACCEPTANCE CRITERIA:**
1. All 9 routes return HTTP 200 on valid requests within 100ms.
2. Invalid Airbnb/VRBO signature -> HTTP 403.
3. Invalid Twilio signature -> HTTP 403.
4. Each valid request enqueues a pg-boss job with the raw payload as job data.
5. POST /webhooks/twilio/sms returns Content-Type: text/xml with <?xml version="1.0"?><Response/>.
6. Routes protected by webhookLimiter.

**FILES:** /backend/src/middleware/webhookAuth.ts, /backend/src/routes/webhooks.ts, /backend/src/index.ts

---

# PILLAR 1 — GUEST COMMUNICATION: BACKEND (T-023 – T-033)

## T-023 — Feature 1.7 — Booking Sync Webhook Worker

**PILLAR:** 1 | **DEPENDS ON:** T-022, T-005

**CONTEXT:** This worker processes booking creation and modification events from POST /webhooks/airbnb/booking and POST /webhooks/vrbo/booking. CRITICAL FIX (ISSUE-03). Without it, no bookings rows exist and the entire system cannot function. PRD Feature 1.7, Section 6.11.

**TASK:** Create /backend/src/jobs/bookingSync.ts. Register boss.work("process-airbnb-booking", handler) and boss.work("process-vrbo-booking", handler) in worker.ts. Handler: extract booking data; find property via listing_id; if not found: log.warn and return; if status === "cancelled": call handleBookingCancellation() stub; otherwise: prisma.bookings.upsert on [account_id, platform, platform_booking_id] — create with status: "upcoming". Also implement booking-sync-sweep stub.

**ACCEPTANCE CRITERIA:**
1. boss.work("process-airbnb-booking") and boss.work("process-vrbo-booking") registered.
2. New booking webhook creates a bookings row with status = "upcoming".
3. Duplicate platform_booking_id for same account/platform -> existing row updated, no new row.
4. listing_id matching no property -> warning logged, no row created.
5. Cancellation payload routes to stub without error.
6. booking-sync-sweep stub registered.

**FILES:** /backend/src/jobs/bookingSync.ts, /backend/src/worker.ts

---

## T-024 — Feature 1.7 — Booking Cancellation Behavior (Section 7.7)

**PILLAR:** 1 | **DEPENDS ON:** T-023, T-009

**CONTEXT:** Booking cancellation events arrive via the booking-sync webhook and are routed from T-023. Three cases defined in PRD Section 7.7: Case A (upcoming), Case B (active, mid-stay), Case C (completed).

**TASK:** In /backend/src/jobs/bookingSync.ts implement handleBookingCancellation(bookingId, accountId): Case A — status "upcoming": set status = "cancelled", return. Case B — status "active": in single transaction: cancel booking, fail open cleaning job, set property_status = "unknown"; send manager alert. Case C — status "completed": log and return.

**ACCEPTANCE CRITERIA:**
1. Case A: bookings.status = "cancelled", no other changes.
2. Case B: booking cancelled + cleaning job failed + property_status = "unknown" in single transaction. Manager alert sent.
3. Case C: no DB changes; event logged.
4. Case B manager alert uses {{business_name}} from accounts.business_name, not hardcoded text.
5. Rule 3 retry applied to alert send.

**FILES:** /backend/src/jobs/bookingSync.ts

---

## T-025 — Feature 1.6 — booking-activation-sweep + booking-sync-sweep Jobs

**PILLAR:** 1 | **DEPENDS ON:** T-023, T-004, T-005

**CONTEXT:** CRITICAL FIX ISSUE-02. Without the booking-activation-sweep, the bookings.status transition from "upcoming" to "active" never fires, breaking the entire mid-stay guest message path (Feature 1.4). Atomic conditional update prevents double-activation.

**TASK:** Create /backend/src/jobs/bookingActivation.ts. Register boss.work("booking-activation-sweep", handler) in worker.ts. Handler: query bookings where status = "upcoming" AND checkin_datetime <= now(); for each: execute raw SQL atomic UPDATE; if 0 rows: skip; if 1 row updated: set properties.property_status = "occupied". Install date-fns-tz for Eastern Time conversions.

**ACCEPTANCE CRITERIA:**
1. boss.work("booking-activation-sweep") registered in worker.ts.
2. Bookings with checkin_datetime <= now() and status = "upcoming" -> updated to "active".
3. Atomic update: 0 rows affected -> skip (no double activation).
4. properties.property_status set to "occupied" for each activated booking's property.
5. Each activation logged with booking_id and property_id.

**FILES:** /backend/src/jobs/bookingActivation.ts, /backend/src/worker.ts

---

## T-026 — Feature 3.1 Trigger A — Work Order Creation Worker Function (Cross-pillar dependency for Feature 1.1)

**PILLAR:** 3 (placed here — needed before T-027) | **DEPENDS ON:** T-010, T-006, T-014

**CONTEXT:** Feature 3.1 Trigger A is invoked SYNCHRONOUSLY from Feature 1.1 when the AI returns MAINTENANCE:[description]. It must be implemented before T-027. This builds only Trigger A (automated, from AI) — Trigger B (manager-initiated) is T-046.

**TASK:** Create /backend/src/jobs/workOrderCreation.ts and export async function createWorkOrderFromAI({ account, property, booking, sourceMessage, maintenanceDescription }). Implement PRD Feature 3.1 Trigger A Steps 1–7: validate description, classify priority per Section 8.1 keyword table, generate AI summary (claude-sonnet-4-20250514, 10s timeout), insert work_orders row, send guest acknowledgment via platform API, send manager notification per priority tier, set messages.maintenance_triggered = true.

**ACCEPTANCE CRITERIA:**
1. createWorkOrderFromAI exported from /backend/src/jobs/workOrderCreation.ts.
2. Empty maintenanceDescription -> standard ESCALATE path; no work_orders row created.
3. Priority classification matches PRD Section 8.1 keyword table for at least one keyword from each tier.
4. work_orders row inserted with reported_by = "guest", status = "open", source_message_id set.
5. Duplicate source_message_id -> unique constraint handled silently.
6. Guest acknowledgment template uses {{ai_summary}} from work_orders.ai_summary and {{business_name}} from accounts.business_name.
7. Manager SMS sent for Urgent and High priority only.
8. messages.maintenance_triggered = true set.

**FILES:** /backend/src/jobs/workOrderCreation.ts

---

## T-027 — Feature 1.1 + 1.4 — AI Inquiry Response Worker

**PILLAR:** 1 | **DEPENDS ON:** T-022, T-026, T-003, T-005, T-006

**CONTEXT:** This is the core of VRM Agent — the AI response worker processing every inbound Airbnb and VRBO guest message. Feature 1.1 (PRD Section 6.4) and Feature 1.4 mid-stay support (Section 6.7). Layer 1 urgent keyword scan runs BEFORE any AI call. Daily AI token cap checked before every AI call.

**TASK:** Create /backend/src/jobs/inquiryResponse.ts. Register boss.work("process-airbnb-message", handler) and boss.work("process-vrbo-message", handler) in worker.ts. Implement: (1) DEDUPLICATION — insert messages row with status "processing" before any AI work; (2) LOOKUP — resolve listing_id -> property, find active booking; (3) TOKEN CAP CHECK — if cap reached: ESCALATE; (4) LAYER 1 URGENT KEYWORD SCAN — if match: URGENT_ESCALATE immediately (no AI call); (5) BUILD PROMPT — construct system prompt entirely from DB values, zero hardcoded values; (6) AI CALL — claude-sonnet-4-20250514, 10s timeout; (7) EVALUATE — parse response per Section 6.3: Normal / ESCALATE / URGENT_ESCALATE / MAINTENANCE; MAINTENANCE -> call createWorkOrderFromAI() synchronously; (8) SEND via platform API with Rule 3 retry; (9) LOG — update messages row.

**ACCEPTANCE CRITERIA:**
1. Duplicate platform_message_id -> second processing job discarded.
2. Layer 1 urgent keyword match -> URGENT_ESCALATE without any AI call.
3. AI token cap reached -> ESCALATE, manager alerted, no AI call.
4. System prompt contains zero hardcoded business names, property data, or operational values.
5. ESCALATE -> guest holding message, manager alerted, messages.status = "escalated", is_urgent = false.
6. URGENT_ESCALATE -> urgent holding message to guest, manager SMS immediately, messages.status = "escalated", is_urgent = true.
7. MAINTENANCE:[description] -> createWorkOrderFromAI() called synchronously, no prior holding message.
8. Normal response -> sent to guest, messages.status = "auto_handled".
9. Rule 3 retry applied on platform API send failure.

**FILES:** /backend/src/jobs/inquiryResponse.ts, /backend/src/worker.ts

---

## T-028 — Feature 1.2 — checkin-message-sweep Job

**PILLAR:** 1 | **DEPENDS ON:** T-025, T-027

**CONTEXT:** Hourly checkin-message-sweep sends pre-arrival messages to guests within the configurable window. All time comparisons use America/New_York. Default template from PRD Section 6.5.

**TASK:** Create /backend/src/jobs/checkinMessage.ts. Register boss.work("checkin-message-sweep", handler) in worker.ts. Query bookings in window, build message from DB values only, send via platform API with Rule 3 retry, update flags. Export sendImmediateCheckinMessage(bookingId) for last-minute override.

**ACCEPTANCE CRITERIA:**
1. boss.work("checkin-message-sweep") registered.
2. Booking within the configurable window receives the check-in message.
3. Booking outside the window is skipped.
4. checkin_message_enabled = false -> property skipped.
5. checkin_message_template used when set; default PRD template when not.
6. Zero hardcoded values — all substitutions from DB.
7. checkin_message_sent = true and checkin_message_sent_at set on success.
8. sendImmediateCheckinMessage exported.

**FILES:** /backend/src/jobs/checkinMessage.ts, /backend/src/worker.ts

---

## T-029 — Feature 1.3 — checkout-reminder-sweep Job

**PILLAR:** 1 | **DEPENDS ON:** T-025

**CONTEXT:** Hourly checkout-reminder-sweep sends checkout reminders to active guests whose checkout date is tomorrow. Send window is 19:30–21:00 Eastern Time. Default template from PRD Section 6.6.

**TASK:** Create /backend/src/jobs/checkoutReminder.ts. Register in worker.ts. Handler: check Eastern Time is 19:30–21:00; query active bookings with tomorrow's checkout; build message from DB; send with Rule 3 retry; set flags. Alert manager at 21:00 if any reminders not sent.

**ACCEPTANCE CRITERIA:**
1. boss.work("checkout-reminder-sweep") registered.
2. Job skips processing entirely when Eastern Time is outside 19:30–21:00.
3. Message sent only to active bookings with tomorrow's checkout date.
4. checkout_reminder_enabled = false -> property skipped.
5. Default template uses database values only.
6. checkout_reminder_sent = true set on success.
7. Missed send at 21:00 triggers manager alert.

**FILES:** /backend/src/jobs/checkoutReminder.ts, /backend/src/worker.ts

---

## T-030 — Feature 1.5 — review-request-sweep Job

**PILLAR:** 1 | **DEPENDS ON:** T-025

**CONTEXT:** Hourly review-request-sweep sends review requests 2 hours after checkout (±0.5h). Message must NOT include a URL — Airbnb's API does not support third-party URLs. Default template from PRD Section 6.8.

**TASK:** Create /backend/src/jobs/reviewRequest.ts. Register in worker.ts. Query completed bookings in ±0.5h window; build message from DB — NO URL; send with Rule 3 retry; set flags.

**ACCEPTANCE CRITERIA:**
1. boss.work("review-request-sweep") registered.
2. Message sent only to completed bookings within the ±0.5h window after checkout.
3. review_request_enabled = false -> property skipped.
4. No URL in the message under any circumstances.
5. {{platform}} resolves to booking.platform value, not hardcoded.
6. review_request_sent = true and review_request_sent_at set on success.

**FILES:** /backend/src/jobs/reviewRequest.ts, /backend/src/worker.ts

---

## T-031 — AI Token Cap Reset + Guest PII Retention Purge Daily Jobs

**PILLAR:** INFRA | **DEPENDS ON:** T-015, T-003, T-006

**CONTEXT:** Two daily maintenance jobs: (1) ai-token-cap-reset resets accounts.daily_ai_token_usage = 0 for all accounts at 00:00 ET. (2) guest-pii-retention-purge deletes guest PII from messages and clears identifying fields on bookings older than 12 months for GDPR/CCPA compliance.

**TASK:** Create /backend/src/jobs/maintenance.ts. Implement aiTokenCapResetHandler and guestPiiPurgeHandler. Register both in worker.ts.

**ACCEPTANCE CRITERIA:**
1. ai-token-cap-reset sets daily_ai_token_usage = 0 and ai_token_cap_reset_at = now() for all accounts.
2. guest-pii-retention-purge deletes messages and clears guest PII on bookings older than 12 months.
3. Both jobs log count of affected rows.
4. Both handlers registered in worker.ts.

**FILES:** /backend/src/jobs/maintenance.ts, /backend/src/worker.ts

---

## T-032 — PATCH /api/messages/:id — Manager Reply via Platform API

**PILLAR:** 1 | **DEPENDS ON:** T-016, T-017, T-022, T-006

**CONTEXT:** When a manager sends a reply in the Message Thread screen, this endpoint delivers via the Airbnb or VRBO platform API, inserts a new outbound messages row, and updates the source message status to "manager_handled". Reply text has a 2000-character limit.

**TASK:** Create /backend/src/routes/messages.ts. Implement PATCH /api/messages/:id: validate reply_text <= 2000 chars; send via platform API with Rule 3 retry; on success: insert outbound messages row (sender='manager', status='manager_handled') and update source message status; on failure: return 500.

**ACCEPTANCE CRITERIA:**
1. PATCH /api/messages/:id protected by JWT auth and account isolation.
2. reply_text > 2000 chars -> 400 validation error.
3. On success: new outbound messages row with sender = "manager", status = "manager_handled".
4. Source message status updated to "manager_handled".
5. Platform API failure after retry -> 500, no messages row inserted.
6. Rate-limited by apiLimiter.

**FILES:** /backend/src/routes/messages.ts, /backend/src/index.ts

---

## T-033 — GET /api/messages + GET /api/bookings

**PILLAR:** 1 | **DEPENDS ON:** T-016, T-017, T-006, T-005

**CONTEXT:** These read endpoints power the Active Alerts panel, Message Log, Booking Status panel, and Message Thread screen.

**TASK:** In /backend/src/routes/messages.ts add GET /api/messages with query params: status (comma-separated), booking_id, property_id, page, limit (default 50). Return messages sorted created_at DESC with properties.name and guest names. Create /backend/src/routes/bookings.ts with GET /api/bookings including all 3 message send status booleans. Register both routers.

**ACCEPTANCE CRITERIA:**
1. GET /api/messages?status=escalated,failed returns only those statuses for authenticated account.
2. GET /api/messages?booking_id=[id] returns all messages for that booking sorted sent_at ASC.
3. Response includes property.name and guest name fields.
4. GET /api/bookings returns bookings with all 3 message send status booleans.
5. Both endpoints enforce account_id isolation.
6. Pagination (page, limit) works on both.

**FILES:** /backend/src/routes/messages.ts, /backend/src/routes/bookings.ts, /backend/src/index.ts

---

# PROPERTIES + CLEANERS API (T-034 – T-037)

## T-034 — GET /api/properties + POST /api/properties + GET /api/properties/:id

**PILLAR:** INFRA | **DEPENDS ON:** T-016, T-017, T-004, T-008

**CONTEXT:** These endpoints power the Property List, Add Property, and Property Detail screens. POST /api/properties creates a new property AND a blank turnover_checklists row in a single transaction. account_id is always derived from the JWT session.

**TASK:** Create /backend/src/routes/properties.ts. GET /api/properties: return all properties for account sorted by name ASC. POST /api/properties: validate required fields; in single Prisma transaction create property + blank turnover_checklists row; return 201. GET /api/properties/:id: return single property with checklist_body and assigned cleaners. Register with apiLimiter.

**ACCEPTANCE CRITERIA:**
1. GET /api/properties returns all properties for authenticated account only.
2. POST /api/properties with missing required field -> 400.
3. POST /api/properties success -> properties AND turnover_checklists rows both created in same transaction.
4. account_id on both rows is from JWT, not request body.
5. GET /api/properties/:id returns property with checklist_body and assigned cleaners.

**FILES:** /backend/src/routes/properties.ts, /backend/src/index.ts

---

## T-035 — PATCH /api/properties/:id

**PILLAR:** INFRA | **DEPENDS ON:** T-034

**CONTEXT:** The Edit Property screen updates any property field AND the checklist_body on the linked turnover_checklists row in a single API call. The endpoint enforces that auto_schedule_cleaner_enabled = true requires an active primary cleaner assignment.

**TASK:** In /backend/src/routes/properties.ts implement PATCH /api/properties/:id: verify property belongs to account; validate auto_schedule constraint; update properties row; upsert turnover_checklists if checklist_body present; handle primary_cleaner_id update in transaction.

**ACCEPTANCE CRITERIA:**
1. PATCH updates properties fields for the authenticated account only.
2. checklist_body in body -> turnover_checklists row updated in same call.
3. auto_schedule_cleaner_enabled = true with no primary cleaner -> 400.
4. Cross-account property ID -> 404.
5. primary_cleaner_id update -> clears old primary, sets new one in a transaction.

**FILES:** /backend/src/routes/properties.ts

---

## T-036 — POST /api/cleaners + PATCH /api/cleaners/:id + GET /api/cleaners

**PILLAR:** INFRA | **DEPENDS ON:** T-007, T-016, T-017

**CONTEXT:** The Cleaners screen manages the account-level cleaner roster. Phone numbers must be E.164 format. PATCH deactivation requires a cascade check — if the cleaner is a primary on any property, the API returns 400 with the property list.

**TASK:** Create /backend/src/routes/cleaners.ts. POST /api/cleaners: validate name, phone (E.164 regex /^\+[1-9]\d{1,14}$/), insert row. GET /api/cleaners: return all cleaners with property assignments. PATCH /api/cleaners/:id: on deactivation, check for primary assignments — if any: return 400 with list; otherwise update. Register with apiLimiter.

**ACCEPTANCE CRITERIA:**
1. POST /api/cleaners with valid E.164 phone -> creates cleaner row.
2. POST /api/cleaners with non-E.164 phone -> 400 with format guidance.
3. GET /api/cleaners returns all cleaners with property assignments.
4. PATCH deactivation with primary assignments -> 400 with property list.
5. PATCH deactivation with no primary assignments -> is_active = false.
6. Account isolation enforced.

**FILES:** /backend/src/routes/cleaners.ts, /backend/src/index.ts

---

## T-037 — PATCH /api/settings + GET /api/account + GET /api/search

**PILLAR:** INFRA | **DEPENDS ON:** T-016, T-017, T-003

**CONTEXT:** PATCH /api/settings updates the manager's account profile and handles platform OAuth token disconnection. GET /api/account powers the Settings screen initial load. GET /api/search provides global search for the nav bar. Max query length 100 chars.

**TASK:** Create /backend/src/routes/settings.ts: GET /api/account returns account row with OAuth connection state booleans. PATCH /api/settings: update allowed fields; handle disconnect_airbnb/disconnect_vrbo by clearing tokens and incrementing token_version. Create /backend/src/routes/search.ts: GET /api/search?q= with ILIKE search across bookings and properties; return { type, id, display_name, url } array.

**ACCEPTANCE CRITERIA:**
1. GET /api/account returns account data with OAuth connection state booleans.
2. PATCH /api/settings updates allowed fields; E.164 re-validation on manager_phone.
3. disconnect_airbnb clears both OAuth tokens and increments token_version.
4. GET /api/search?q= returns matching bookings and properties for authenticated account only.
5. q > 100 chars -> 400.
6. Search results include type, id, display_name, url.

**FILES:** /backend/src/routes/settings.ts, /backend/src/routes/search.ts, /backend/src/index.ts

---

# PILLAR 2 — CLEANING & TURNOVER: BACKEND (T-038 – T-045)

## T-038 — Twilio SMS Webhook Worker — Inbound SMS Routing Logic (Section 7.1)

**PILLAR:** 2 | **DEPENDS ON:** T-022, T-007, T-009

**CONTEXT:** Central routing hub for all cleaner SMS replies. Applies Twilio MessageSid deduplication, multi-job guard, and dispatches to four handlers. Feature 2.2, 2.3, and 2.4 handlers are stubs replaced in T-040–T-042.

**TASK:** Create /backend/src/jobs/twilioSms.ts. Register boss.work("process-twilio-sms", handler) in worker.ts. Handler: (1) DEDUPLICATION via inbound_sms_sids; (2) CLEANER LOOKUP by phone; (3) MULTI-JOB GUARD — if >1 open job: append MessageSid, send manager alert using PRD Section 7.1 template with all {{variables}} from DB, return; (4) if 0 open jobs: log orphaned; (5) if 1 open job: append MessageSid; (6) ROUTE based on exact body matching: "confirm" -> confirmHandler stub; "done" -> doneHandler stub; "low:" -> lowHandler stub; else: log.warn.

**ACCEPTANCE CRITERIA:**
1. boss.work("process-twilio-sms") registered.
2. Duplicate MessageSid in any recent job's inbound_sms_sids -> discarded.
3. Unknown phone -> logged and discarded.
4. Cleaner with 2 open jobs -> multi-job guard alert sent using DB values; MessageSid appended; routing skipped.
5. "confirm" -> confirmHandler stub called; "done" -> doneHandler stub; "low: ..." -> lowHandler stub.
6. Unrecognized body -> logged and discarded.
7. Multi-job alert uses {{business_name}} from DB, not hardcoded.

**FILES:** /backend/src/jobs/twilioSms.ts, /backend/src/worker.ts

---

## T-039 — Feature 2.1 — Auto-Schedule Cleaner (checkout-detection-sweep + Checkout Webhook Worker)

**PILLAR:** 2 | **DEPENDS ON:** T-025, T-007, T-009, T-015

**CONTEXT:** Feature 2.1 detects guest checkout and auto-dispatches the primary cleaner via SMS. Trigger B (hourly sweep) and Trigger A (checkout webhook) both share the dispatchCleaner() function. Atomic conditional update prevents double-processing. IMPORTANT: T-039 is placed in Session 2 because it depends on T-025 (booking-activation-sweep). Do not move it to Session 3.

**TASK:** Create /backend/src/jobs/checkoutDetection.ts. Export async function dispatchCleaner(bookingId): (1) atomic raw SQL UPDATE bookings SET status = "completed" WHERE id AND status = "active" — if 0 rows: discard; (2) set properties.property_status = "needs_cleaning"; (3) check auto_schedule_cleaner_enabled; (4) find primary cleaner; (5) find next upcoming booking for deadline; (6) prisma.cleaning_jobs.create — on UNIQUE constraint: discard; (7) build SMS from PRD Section 7.2 template; send via Twilio with Rule 3; (8) set flags. Register boss.work for checkout-detection-sweep, process-airbnb-checkout, process-vrbo-checkout.

**ACCEPTANCE CRITERIA:**
1. boss.work("checkout-detection-sweep") registered.
2. boss.work("process-airbnb-checkout") and boss.work("process-vrbo-checkout") registered.
3. Atomic update prevents double-dispatch.
4. auto_schedule_cleaner_enabled = false -> cleaner not dispatched, logged.
5. No active primary cleaner -> manager alert, no cleaning_jobs row.
6. Duplicate booking_id on INSERT -> discarded silently.
7. SMS uses PRD Section 7.2 template with all {{variables}} from DB.
8. job_notification_sent = true on SMS success.

**FILES:** /backend/src/jobs/checkoutDetection.ts, /backend/src/worker.ts

---

## T-040 — Feature 2.2 — Turnover Checklist Delivery (CONFIRM Handler)

**PILLAR:** 2 | **DEPENDS ON:** T-038, T-008

**CONTEXT:** When a cleaner replies CONFIRM, the job transitions to "confirmed" and the turnover checklist is sent via SMS. Blank or missing checklist_body means the checklist is not configured — status is still updated but manager is alerted and checklist send is skipped. This implements the confirmHandler function stubbed in T-038.

**TASK:** In /backend/src/jobs/twilioSms.ts replace the confirmHandler stub: verify status IN ["scheduled","no_response"]; if already confirmed + checklist_sent: discard; set status = "confirmed", cleaner_confirmed_at = now(); look up turnover_checklists — if blank: alert manager, return without sending checklist; build and send checklist SMS with Rule 3; set checklist_sent = true.

**ACCEPTANCE CRITERIA:**
1. confirmHandler replaces stub in twilioSms.ts.
2. Duplicate CONFIRM when already confirmed + checklist sent -> discarded.
3. status = "confirmed" and cleaner_confirmed_at set.
4. Missing or blank checklist_body -> manager alerted; job still confirmed; no SMS to cleaner.
5. Checklist SMS sent with checklist_body from DB.
6. checklist_sent = true on successful SMS delivery.

**FILES:** /backend/src/jobs/twilioSms.ts

---

## T-041 — Feature 2.3 — Completion Confirmation (DONE Handler)

**PILLAR:** 2 | **DEPENDS ON:** T-038, T-040

**CONTEXT:** When a cleaner replies DONE, the job is marked complete, property_status set to "guest_ready", and damage keywords are scanned. CRITICAL: cleaning_jobs.damage_fyi_sent = true must be set IN THE SAME TRANSACTION as the status update, BEFORE attempting to send the FYI alert. This is PRD v0.4 ISSUE-29 fix. Verify acceptance criterion #3 explicitly.

**TASK:** In twilioSms.ts replace doneHandler stub: verify status IN ["scheduled","confirmed"]; IN A SINGLE PRISMA TRANSACTION: set status = "completed", completed_at, closed_by = "cleaner_sms", completion_sms_raw; run damage keyword scan against PRD Section 7.4 keywords; if match: SET damage_fyi_sent = true IN THIS SAME TRANSACTION; set properties.property_status = "guest_ready"; THEN send FYI alert (failure does not revert damage_fyi_sent); call lowHandler if "low:" present; send completion ack and manager notification.

**ACCEPTANCE CRITERIA:**
1. doneHandler sets status = "completed", closed_by = "cleaner_sms", completion_sms_raw stored.
2. properties.property_status = "guest_ready".
3. **Damage keyword match -> damage_fyi_sent = true SET IN THE SAME TRANSACTION as status update.**
4. Damage FYI alert send failure does NOT revert damage_fyi_sent — it remains true.
5. Body with "low:" -> lowHandler called after DONE processing.
6. Completion ack and manager notification sent.

**FILES:** /backend/src/jobs/twilioSms.ts

---

## T-042 — Feature 2.4 — Supply Restocking Alert (LOW: Handler)

**PILLAR:** 2 | **DEPENDS ON:** T-038

**CONTEXT:** When a cleaner includes "LOW: [items]" in an SMS (standalone or combined with DONE), the system parses supply items, stores them in cleaning_jobs.supply_flags, and sends a supply alert to the manager. If alert permanently fails, supply_alert_permanently_failed = true.

**TASK:** In twilioSms.ts replace lowHandler stub: extract text after "LOW:", split on commas, trim, normalize to lowercase, dedup; if 0 items: generic alert; otherwise: merge into supply_flags, build alert from PRD Section 7.5 template with all {{variables}} from DB, send via alert_channel with Rule 3; on success: set supply_alert_sent = true, supply_alert_sent_at; on permanent failure: supply_alert_permanently_failed = true.

**ACCEPTANCE CRITERIA:**
1. "LOW: towels, soap" -> supply_flags = ["towels", "soap"] stored on cleaning job.
2. Duplicate items deduplicated (case-insensitive) when merging.
3. Zero parsed items -> generic alert sent, supply_alert_sent = true.
4. supply_alert_sent = true and supply_alert_sent_at on successful delivery.
5. Send failure after retry -> supply_alert_permanently_failed = true.
6. All alert text uses {{business_name}} from DB, not hardcoded.

**FILES:** /backend/src/jobs/twilioSms.ts

---

## T-043 — Feature 2.5 — cleaner-no-response-check Job

**PILLAR:** 2 | **DEPENDS ON:** T-038, T-015

**CONTEXT:** CRITICAL FIX ISSUE-04. Without this, the "no_response" status transition never fires. The job checks jobs past the cleaner_confirmation_window_minutes window (read from property row — default 60) and transitions them atomically. PRD Feature 2.5, Section 7.6.

**TASK:** Create /backend/src/jobs/cleanerNoResponse.ts. Register boss.work("cleaner-no-response-check", handler) in worker.ts. Query jobs past their window; atomic UPDATE status = "no_response" WHERE status = "scheduled"; if 0 rows: skip; send manager alert via alert_channel using PRD Section 7.6 templates with all {{variables}} from DB; set no_response_alert_sent = true.

**ACCEPTANCE CRITERIA:**
1. boss.work("cleaner-no-response-check") registered.
2. Jobs past the confirmation window -> status = "no_response".
3. Atomic update — no double-transition.
4. Window uses properties.cleaner_confirmation_window_minutes from DB, not hardcoded 60.
5. no_response_alert_sent = true after alert.
6. SMS and email templates use {{variables}} from DB only.

**FILES:** /backend/src/jobs/cleanerNoResponse.ts, /backend/src/worker.ts

---

## T-044 — pre-checkin-alert-check Job

**PILLAR:** 2 | **DEPENDS ON:** T-039, T-015

**CONTEXT:** The pre-checkin-alert-check hourly job warns the manager when a cleaning job is not complete and the next guest's check-in is approaching. Two alert variants: standard (deadline approaching) and overdue (deadline passed). Window is properties.pre_checkin_alert_minutes (default 30). Templates added in PRD v0.4 ISSUE-22 fix, Section 7.4.

**TASK:** Create /backend/src/jobs/preCheckinAlert.ts. Register boss.work("pre-checkin-alert-check", handler) in worker.ts. Query incomplete jobs with next_booking_id in alert window; if deadline >= NOW(): standard alert; if deadline < NOW(): overdue alert; send via alert_channel with Rule 3; set pre_checkin_alert_sent = true. All {{variables}} from DB. Convert next checkin to Eastern Time.

**ACCEPTANCE CRITERIA:**
1. boss.work("pre-checkin-alert-check") registered.
2. Standard alert sent when deadline >= NOW() and within alert window.
3. Overdue alert sent when deadline < NOW().
4. Jobs outside alert window skipped.
5. pre_checkin_alert_sent = true after alert attempted.
6. {{next_checkin_eastern}} converts checkin_datetime to Eastern Time.

**FILES:** /backend/src/jobs/preCheckinAlert.ts, /backend/src/worker.ts

---

## T-045 — GET /api/cleaning-jobs + PATCH /api/cleaning-jobs/:id + PATCH /api/cleaning-jobs/:id/dismiss-damage

**PILLAR:** 2 | **DEPENDS ON:** T-016, T-017, T-009

**CONTEXT:** These three endpoints power the Turnover Status, Supply Alerts, and Damage Reports panels. The manual close PATCH must set properties.property_status = "guest_ready" in the same transaction as the status update — PRD v0.4 ISSUE-18 fix.

**TASK:** Create /backend/src/routes/cleaningJobs.ts. GET /api/cleaning-jobs with query params including supply_alerts and damage_reports filters. PATCH /api/cleaning-jobs/:id: if manual close: set status + properties.property_status = "guest_ready" in SINGLE TRANSACTION; if supply_alert_dismissed: update only that field. PATCH /api/cleaning-jobs/:id/dismiss-damage: set damage_report_dismissed = true. Register with apiLimiter.

**ACCEPTANCE CRITERIA:**
1. GET /api/cleaning-jobs returns jobs with related property, cleaner, and next booking data.
2. ?supply_alerts=true filter returns supply alert jobs correctly.
3. ?damage_reports=true filter excludes jobs that already have a work order.
4. Manual close PATCH: status = "completed" AND properties.property_status = "guest_ready" in single transaction.
5. dismiss-damage PATCH sets damage_report_dismissed = true.
6. Account isolation enforced on all three endpoints.

**FILES:** /backend/src/routes/cleaningJobs.ts, /backend/src/index.ts

---

# PILLAR 3 — MAINTENANCE INTAKE: BACKEND (T-046 – T-049)

## T-046 — POST /api/work-orders — Manager-Initiated Work Order (Trigger B)

**PILLAR:** 3 | **DEPENDS ON:** T-010, T-016, T-017

**CONTEXT:** This endpoint handles Feature 3.1 Trigger B: the manager manually creates a work order from the Damage Reports panel. reported_by is ALWAYS set SERVER-SIDE — if source_cleaning_job_id is provided: reported_by = "cleaner"; otherwise "manager". The client must NEVER send reported_by in the request body (PRD v0.4 ISSUE-10 fix).

**TASK:** Create /backend/src/routes/workOrders.ts. POST /api/work-orders: validate required fields; SERVER-SIDE reported_by (NEVER read req.body.reported_by); generate AI summary with claude-sonnet-4-20250514, 10s timeout, fallback to 100-char truncation; create work_orders row with status = "open"; return 201. Register with apiLimiter.

**ACCEPTANCE CRITERIA:**
1. POST /api/work-orders creates row with status = "open".
2. source_cleaning_job_id in body -> reported_by = "cleaner" (server-set).
3. No source_cleaning_job_id -> reported_by = "manager" (server-set).
4. req.body.reported_by is ignored.
5. ai_summary generated from AI; fallback to 100-char truncation on failure.
6. account_id from JWT only.

**FILES:** /backend/src/routes/workOrders.ts, /backend/src/index.ts

---

## T-047 — GET /api/work-orders + PATCH /api/work-orders/:id

**PILLAR:** 3 | **DEPENDS ON:** T-046

**CONTEXT:** These endpoints power the Work Orders screen and Work Order Detail modal. GET supports filtering. PATCH handles status transitions and concurrent edit detection — HTTP 409 if updated_at check differs.

**TASK:** In /backend/src/routes/workOrders.ts implement GET /api/work-orders with status/property_id filters; active list sorted priority-first (urgent->high->medium->low) then created_at ASC; resolved archive sorted resolved_at DESC paginated 50/page; join properties.name. PATCH /api/work-orders/:id: check updated_at_check for 409; accept status, priority, manager_notes updates; on "resolved": set resolved_at = now(), resolved_by = "manager".

**ACCEPTANCE CRITERIA:**
1. Active list sorted priority-first (urgent -> high -> medium -> low) then created_at.
2. Resolved archive sorted by resolved_at DESC, paginated 50/page.
3. PATCH to "resolved" -> resolved_at and resolved_by = "manager" set.
4. Stale updated_at_check -> 409.
5. manager_notes saved as free text.
6. Account isolation enforced.

**FILES:** /backend/src/routes/workOrders.ts

---

## T-048 — Feature 3.2 — Review Response Webhook Worker

**PILLAR:** 3 | **DEPENDS ON:** T-011, T-022, T-015

**CONTEXT:** This pg-boss worker processes Airbnb and VRBO review events. Deduplicates on platform_review_id, generates AI draft (positive for rating >= 4; negative/neutral for <= 3, including 3-star), notifies manager. Empty review_text uses static fallback. booking_id always NULL in MVP.

**TASK:** Create /backend/src/jobs/reviewResponseDraft.ts. Register boss.work("process-airbnb-review", handler) and boss.work("process-vrbo-review", handler) in worker.ts. Handler: DEDUP check; property lookup; empty review_text -> static fallback, no_review_text = true; rating >= 4 -> positive prompt; rating <= 3 -> negative/neutral prompt; AI call 10s timeout; INSERT review_drafts with booking_id = null, status = "pending"; send manager notification via alert_channel.

**ACCEPTANCE CRITERIA:**
1. boss.work("process-airbnb-review") and boss.work("process-vrbo-review") registered.
2. Duplicate platform_review_id -> discarded.
3. Empty review_text -> static fallback, no_review_text = true, no AI call.
4. rating >= 4 -> positive prompt used.
5. rating <= 3 (including exactly 3) -> negative/neutral prompt used.
6. AI failure -> draft_response = null, ai_failed = true.
7. review_drafts row inserted with status = "pending".
8. Manager notification sent via alert_channel using DB values.

**FILES:** /backend/src/jobs/reviewResponseDraft.ts, /backend/src/worker.ts

---

## T-049 — GET /api/review-drafts + PATCH /api/review-drafts/:id + POST /api/review-drafts/:id/retry

**PILLAR:** 3 | **DEPENDS ON:** T-048, T-016, T-017

**CONTEXT:** These three endpoints power the Review Responses panel and Review Draft modal. GET returns pending and paginated resolved drafts. PATCH handles "copied" and "dismissed" transitions. POST /retry re-triggers AI generation for ai_failed = true drafts.

**TASK:** Create /backend/src/routes/reviewDrafts.ts. GET /api/review-drafts: return pending (sorted created_at DESC) and resolved (50/page sorted updated_at DESC). GET /api/review-drafts/:id: single draft. PATCH /api/review-drafts/:id: accept status "copied" or "dismissed". POST /api/review-drafts/:id/retry: if ai_failed = false -> 400; re-run AI with same rating-based prompt; on success: update draft, clear ai_failed; on failure: 500. Register with apiLimiter.

**ACCEPTANCE CRITERIA:**
1. GET returns pending drafts and paginated resolved drafts with property.name.
2. GET /api/review-drafts/:id returns single draft with account isolation.
3. PATCH status = "copied" -> status updated.
4. PATCH status = "dismissed" -> status updated.
5. POST retry on ai_failed = true draft -> re-runs AI, clears ai_failed on success.
6. POST retry on non-failed draft -> 400.
7. Account isolation enforced.

**FILES:** /backend/src/routes/reviewDrafts.ts, /backend/src/index.ts

---

# FRONTEND SCREENS (T-050 – T-062)

## T-050 — Login Screen + Forgot Password Screen (Screens 1 & 2)

**PILLAR:** INFRA | **DEPENDS ON:** T-019, T-020, T-021

**CONTEXT:** These are the two public-facing screens. The central API client created here handles 401 interception and URL preservation for all screens. Specs from Screens Document Section 4, Screens 1 and 2.

**TASK:** Create /frontend/lib/api.ts as the central API client: a fetch wrapper with credentials: "include" on every request; on HTTP 401: redirect to /login?session_expired=true&redirect=[currentPath]. Create /frontend/app/(public)/login/page.tsx: centered form; on ?session_expired: banner "Your session expired. Please log in again."; on ?reset_sent: banner "Check your email for a reset link."; on success: redirect to redirect param or /dashboard. Create /frontend/app/(public)/forgot-password/page.tsx: email field; on success: redirect to /login?reset_sent=true.

**ACCEPTANCE CRITERIA:**
1. /login page renders email + password form.
2. Successful login redirects to /dashboard (or preserved URL).
3. "Incorrect email or password." shown inline on wrong credentials.
4. ?session_expired=true -> session expired banner shown.
5. ?reset_sent=true -> "Check your email for a reset link." banner shown.
6. /forgot-password submits to POST /auth/forgot-password; success -> redirect to /login?reset_sent=true.
7. /frontend/lib/api.ts exports fetch wrapper with 401 -> login redirect logic.

**FILES:** /frontend/lib/api.ts, /frontend/app/(public)/login/page.tsx, /frontend/app/(public)/forgot-password/page.tsx

---

## T-051 — Global UI Infrastructure — Layout, Nav Bar, Session Interceptor, AI Cap Banner

**PILLAR:** INFRA | **DEPENDS ON:** T-050

**CONTEXT:** Every authenticated screen uses the same global layout and shared components. The persistent nav bar links to all 5 main sections. The AI token cap banner appears on all authenticated screens when the daily cap is reached. Confirmation dialogs required for 4 irreversible actions. Loading components reused across all screens.

**TASK:** Create /frontend/app/(authenticated)/layout.tsx wrapping all protected routes with AuthenticatedLayout. Create /frontend/components/AuthenticatedLayout.tsx: nav bar with links + GlobalSearch slot + Logout button. Create /frontend/components/AICapBanner.tsx: fetches GET /api/account on mount, shows persistent banner when daily_ai_token_usage >= ai_token_daily_cap. Create /frontend/components/ConfirmDialog.tsx: focus-trapped modal, Cancel has default focus. Create /frontend/components/LoadingSpinner.tsx and /frontend/components/Skeleton.tsx.

**ACCEPTANCE CRITERIA:**
1. All routes under /frontend/app/(authenticated)/ wrapped in AuthenticatedLayout.
2. Nav bar renders all 5 links and Logout button.
3. Logout calls POST /auth/logout and redirects to /login.
4. AICapBanner shows when daily_ai_token_usage >= ai_token_daily_cap.
5. ConfirmDialog traps focus; Cancel has default focus; accessible via keyboard.
6. LoadingSpinner and Skeleton components exported and reusable.

**FILES:** /frontend/app/(authenticated)/layout.tsx, /frontend/components/AuthenticatedLayout.tsx, /frontend/components/AICapBanner.tsx, /frontend/components/ConfirmDialog.tsx, /frontend/components/LoadingSpinner.tsx, /frontend/components/Skeleton.tsx

---

## T-052 — Global Search Component

**PILLAR:** INFRA | **DEPENDS ON:** T-051, T-037

**CONTEXT:** The global search input in the nav bar enables managers to find a specific guest in under 5 seconds across 50+ properties. 300ms debounce, keyboard navigation, max 100 chars. Results link to Message Thread for bookings and Property Detail for properties.

**TASK:** Create /frontend/components/GlobalSearch.tsx: input with 300ms debounce; >= 2 chars -> GET /api/search?q=; dropdown with results grouped by type (Bookings / Properties); click -> router.push(result.url); keyboard nav: ArrowDown/ArrowUp/Enter/Escape; loading spinner; empty state "No results found."; maxLength={100}. Wire into AuthenticatedLayout.tsx nav bar.

**ACCEPTANCE CRITERIA:**
1. Input debounces 300ms.
2. >= 2 chars -> GET /api/search?q= called.
3. Results appear grouped by Bookings and Properties.
4. Click on result -> navigates to result.url.
5. ArrowDown/ArrowUp/Enter/Escape keyboard nav works.
6. Empty results -> "No results found."
7. Input max 100 chars enforced.

**FILES:** /frontend/components/GlobalSearch.tsx, /frontend/components/AuthenticatedLayout.tsx

---

## T-053 — Dashboard Screen — All 7 Panels (Screen 3)

**PILLAR:** 1 | **DEPENDS ON:** T-051, T-033, T-045, T-047, T-049

**CONTEXT:** The Dashboard has 7 data panels plus 2 conditional banners. Active Alerts polls every 60 seconds using the Page Visibility API. Supply Alerts and Damage Reports panels HIDDEN entirely when empty. Color: red = is_urgent = true or status = "failed"; yellow = escalated + not urgent. This ticket is ALWAYS LAST in Session 4 — depends on the most backend endpoints. Do NOT reorder.

**TASK:** Create /frontend/app/(authenticated)/dashboard/page.tsx. Implement all 7 panels as independent sections each with its own loading skeleton: (1) Active Alerts with 60s polling + Page Visibility API; (2) Properties Status tiles with 4-color status badges; (3) Booking Status with 3 send flag indicators; (4) Open Work Orders sorted urgent-first with WorkOrderModal; (5) Supply Alerts — HIDDEN when empty; (6) Damage Reports — HIDDEN when empty; (7) Pending Review Drafts with ReviewDraftModal.

**ACCEPTANCE CRITERIA:**
1. All 7 panels render with correct data from respective endpoints.
2. Active Alerts polls every 60s; pauses when tab is hidden (Page Visibility API); resumes on tab focus.
3. Red rows: is_urgent = true OR status = "failed". Yellow: escalated + not urgent.
4. Supply Alerts and Damage Reports panels hidden entirely when empty (no placeholder shown).
5. Each panel loads with its own skeleton independently.
6. Clicking an Active Alert row navigates to the correct message thread URL.
7. Dismiss Supply Alert calls PATCH /api/cleaning-jobs/[id].

**FILES:** /frontend/app/(authenticated)/dashboard/page.tsx

---

## T-054 — Property List Screen (Screen 4)

**PILLAR:** 1 | **DEPENDS ON:** T-051, T-034

**CONTEXT:** The Property List screen shows all properties with their operational status. Specs from Screens Document Section 4, Screen 4.

**TASK:** Create /frontend/app/(authenticated)/properties/page.tsx: fetch GET /api/properties; render each property as a clickable row with name, address, property_status badge (4 colors), platform icons based on listing ID presence; row click -> /properties/[id]; Add Property button -> /properties/new. Loading, empty, and error states.

**ACCEPTANCE CRITERIA:**
1. GET /api/properties called on mount; rows rendered with name, address, status badge.
2. property_status badge shows correct color per status value.
3. Platform icons shown based on listing ID presence.
4. Row click -> /properties/[id].
5. Add Property button -> /properties/new.
6. Loading, empty, and error states all render correctly.

**FILES:** /frontend/app/(authenticated)/properties/page.tsx

---

## T-055 — Add Property Screen (Screen 5)

**PILLAR:** 1 | **DEPENDS ON:** T-051, T-034

**CONTEXT:** The Add Property screen is a 6-section form. Saving calls POST /api/properties. Template text areas pre-populated with defaults from PRD Sections 6.5, 6.6, and 6.8. Specs from Screens Document Section 4, Screen 5.

**TASK:** Create /frontend/app/(authenticated)/properties/new/page.tsx with 6 sections: Basic Info, Access & Logistics, Guest Info, Platform IDs (with non-blocking warning), Automated Messages (3 rows with toggles + pre-populated templates), Cleaning Settings. Save -> POST /api/properties -> /properties/[new_id]. Cancel -> /properties.

**ACCEPTANCE CRITERIA:**
1. All 6 sections render with correct field types and defaults.
2. Save with missing required field -> inline validation, save blocked.
3. Successful POST /api/properties -> navigates to /properties/[new_id].
4. Cancel -> /properties.
5. Template textareas pre-populated with correct PRD default templates.
6. API error -> toast shown, form data preserved.

**FILES:** /frontend/app/(authenticated)/properties/new/page.tsx

---

## T-056 — Edit Property Screen (Screen 6)

**PILLAR:** 1 | **DEPENDS ON:** T-051, T-035, T-036

**CONTEXT:** Edit Property pre-populates all property fields and adds Cleaner Assignment and Turnover Checklist sections. Saving calls PATCH /api/properties/:id. NOTE: Session 4 must NOT modify backend files. If a missing endpoint is discovered, log as a gap and continue with a placeholder.

**TASK:** Create /frontend/app/(authenticated)/properties/[id]/edit/page.tsx: fetch GET /api/properties/[id]; pre-populate all 6 Add Property sections; add Cleaner Assignment section (with GET /api/cleaners for dropdown, primary toggle, remove link); add Turnover Checklist textarea. Validation: auto_schedule = true + no primary -> inline error + save blocked. Save -> PATCH /api/properties/[id].

**ACCEPTANCE CRITERIA:**
1. All fields pre-populated from existing property.
2. Cleaner Assignment shows assigned cleaners with primary badge.
3. Setting new primary -> old primary cleared in form state; submitted to API.
4. Turnover checklist textarea pre-populated with checklist_body.
5. auto_schedule = true + no primary -> inline error, save blocked.
6. PATCH /api/properties/[id] on save; success -> /properties/[id].

**FILES:** /frontend/app/(authenticated)/properties/[id]/edit/page.tsx

---

## T-057 — Property Detail Screen (Screen 7)

**PILLAR:** 1 | **DEPENDS ON:** T-051, T-033, T-034, T-045, T-047

**CONTEXT:** Property Detail is the full operational view for one property with 6 independent data sections, each with its own loading spinner. Message log paginated at 50. Cleaning job rows have "Mark as Completed" button. All timestamps in Eastern Time. Specs from Screens Document Section 4, Screen 7.

**TASK:** Create /frontend/app/(authenticated)/properties/[id]/page.tsx with 6 independent sections: Header, Upcoming/Active Bookings, Message Log (with Load more, status badges, click -> thread), Cleaning Jobs (with status badges and Mark as Completed PATCH), Work Orders (with WorkOrderModal), New Work Order button. Each section has own skeleton, empty state, and error/retry state.

**ACCEPTANCE CRITERIA:**
1. 6 sections load independently with their own spinners.
2. Message status badges render correct colors per mapping.
3. Message row click -> /properties/[id]/messages/[bookingId].
4. Mark as Completed calls PATCH; badge updates to green in-place.
5. Timestamps in Eastern Time format.
6. Message log "Load more" loads previous 50.

**FILES:** /frontend/app/(authenticated)/properties/[id]/page.tsx

---

## T-058 — Message Thread Screen (Screen 8)

**PILLAR:** 1 | **DEPENDS ON:** T-051, T-032, T-033

**CONTEXT:** The Message Thread screen shows the full conversation and enables manual reply. Default scroll position is bottom. "Load earlier" loads previous 50. Failed-message banner when opened from failed alert. Reply limited to 2000 characters. Specs from Screens Document Section 4, Screen 8.

**TASK:** Create /frontend/app/(authenticated)/properties/[id]/messages/[bookingId]/page.tsx: booking header; thread with 50 most recent messages auto-scrolled to bottom; "Load earlier messages" at top; each message: direction, sender, content, status badge (Green=auto_handled, Yellow=escalated, Blue=manager_handled, Red=failed, Gray=no_response_needed), timestamp Eastern; failed banner when any message has status = "failed"; reply box: textarea max 2000 chars, live char count, Send button disabled at 0 or >2000, optimistic "Sending..." badge -> PATCH /api/messages/:id.

**ACCEPTANCE CRITERIA:**
1. Thread loads 50 most recent messages scrolled to bottom.
2. Load earlier at top loads previous 50.
3. Status badges render with correct colors.
4. Live character count; Send disabled at 0 or > 2000 chars.
5. Send -> optimistic "Sending..." -> resolves to correct status badge.
6. Failed banner shown when any message in thread has status = "failed".
7. All timestamps in Eastern Time.

**FILES:** /frontend/app/(authenticated)/properties/[id]/messages/[bookingId]/page.tsx

---

## T-059 — Work Orders Screen (Screen 9) + Work Order Detail Modal (Screen 10)

**PILLAR:** 3 | **DEPENDS ON:** T-051, T-047, T-046

**CONTEXT:** The Work Orders screen shows all open and in-progress work orders sorted priority-first. The Work Order Detail modal handles view, status transitions, priority overrides, manager notes, and create mode. HTTP 409 concurrent edit detection blocks saving. Specs from Screens Document Section 4, Screens 9 and 10.

**TASK:** Create /frontend/app/(authenticated)/work-orders/page.tsx: active list table with priority badges (Red=urgent, Orange=high, Yellow=medium, Gray=low), filter dropdowns, resolved archive collapsible with Load More, Create Work Order button. Create /frontend/components/WorkOrderModal.tsx: opens on #wo-[id] hash; priority dropdown with optimistic PATCH; Mark In Progress; Mark Resolved -> ConfirmDialog -> PATCH; manager_notes auto-saves on blur; 409 -> banner; create mode with POST /api/work-orders.

**ACCEPTANCE CRITERIA:**
1. List shows open + in_progress sorted priority-first.
2. Resolved archive collapsible with Load More pagination.
3. Priority dropdown -> PATCH on change; optimistic update; reverts on failure.
4. Mark In Progress -> badge updates.
5. Mark Resolved -> ConfirmDialog -> moves to archive, modal closes.
6. manager_notes auto-saves on blur.
7. 409 response -> banner shown, save blocked.
8. URL hash #wo-[id] added on open, removed on close.

**FILES:** /frontend/app/(authenticated)/work-orders/page.tsx, /frontend/components/WorkOrderModal.tsx

---

## T-060 — Review Draft Modal (Screen 11)

**PILLAR:** 3 | **DEPENDS ON:** T-051, T-049

**CONTEXT:** The Review Draft modal opened from Dashboard's Pending Review Drafts panel. Two conditional banners for no-text reviews and AI failures. Copy Draft copies to clipboard and marks "copied". Permanent non-dismissable posting reminder always visible. Specs from Screens Document Section 4, Screen 11.

**TASK:** Create /frontend/components/ReviewDraftModal.tsx: opens on #review-[id] hash; fetch GET /api/review-drafts/:id; header with star rating as filled/empty icons; original review read-only; no_review_text banner; ai_failed banner + Retry button -> POST /retry; editable textarea with char count; Copy Draft -> clipboard + PATCH status="copied" -> "Copied ✓" 3 seconds; Dismiss -> ConfirmDialog -> PATCH status="dismissed"; permanent non-dismissable posting reminder always visible.

**ACCEPTANCE CRITERIA:**
1. Star rating rendered as filled/empty star icons.
2. no_review_text banner shown when no_review_text = true.
3. ai_failed banner + Retry button shown when ai_failed = true.
4. Retry -> POST /api/review-drafts/[id]/retry -> textarea populated on success.
5. Copy Draft -> clipboard copy -> PATCH status="copied" -> "Copied ✓" 3 seconds.
6. Dismiss -> ConfirmDialog -> PATCH status="dismissed" -> modal closes.
7. Permanent posting reminder always visible with no dismiss option.
8. URL hash added/removed correctly.

**FILES:** /frontend/components/ReviewDraftModal.tsx

---

## T-061 — Cleaners Screen (Screen 12)

**PILLAR:** 2 | **DEPENDS ON:** T-051, T-036

**CONTEXT:** The Cleaners screen manages the account-level cleaner roster. Deactivation has a BLOCKING cascade warning (not a standard confirm dialog) when the cleaner is a primary on any property. The blocking warning lists all affected properties and prevents deactivation until conflicts are resolved. Specs from Screens Document Section 4, Screen 12.

**TASK:** Create /frontend/app/(authenticated)/cleaners/page.tsx: fetch GET /api/cleaners; render cleaner list with all fields; Add Cleaner inline form with E.164 validation; each row has Edit mode with inline PATCH; Deactivate button: if API returns 400 with property list -> BLOCKING WARNING (not ConfirmDialog) listing properties; if no conflict -> standard ConfirmDialog -> PATCH; Loading and empty states.

**ACCEPTANCE CRITERIA:**
1. GET /api/cleaners renders cleaner list with all fields.
2. Add Cleaner form validates E.164 phone inline.
3. Edit -> inline save via PATCH.
4. Deactivate with primary conflict -> blocking warning listing properties (not ConfirmDialog).
5. Deactivate without conflict -> row grays out (is_active = false).
6. Loading and empty states render.

**FILES:** /frontend/app/(authenticated)/cleaners/page.tsx

---

## T-062 — Settings Screen (Screen 13)

**PILLAR:** INFRA | **DEPENDS ON:** T-051, T-037

**CONTEXT:** The Settings screen manages account profile, alert preferences, communication tone, and Airbnb/VRBO OAuth connections. OAuth connect flow opens in a new tab and signals the Settings tab via BroadcastChannel API. Disconnect shows a ConfirmDialog warning. Specs from Screens Document Section 4, Screen 13.

**TASK:** Create /frontend/app/(authenticated)/settings/page.tsx: fetch GET /api/account; 5 form sections: Profile, Alert Preferences, Agent Tone, Platform Connections Airbnb, Platform Connections VRBO; Save -> PATCH /api/settings -> "Settings saved." toast; Platform connect: open OAuth URL in new tab; listen on new BroadcastChannel("vrm-oauth") for callback signal; fallback: poll GET /api/account every 3s for 2 minutes; Disconnect: ConfirmDialog -> PATCH /api/settings { disconnect_airbnb: true } -> row shows Not Connected; Loading and saving states.

**ACCEPTANCE CRITERIA:**
1. All 5 sections render pre-populated from GET /api/account.
2. PATCH /api/settings on Save -> "Settings saved." toast.
3. manager_phone E.164 validation inline.
4. Platform Connect opens new tab.
5. BroadcastChannel("vrm-oauth") listener refreshes connection state on OAuth callback.
6. Disconnect -> ConfirmDialog -> PATCH clears tokens -> row shows Not Connected.
7. Loading and saving states handled.

**FILES:** /frontend/app/(authenticated)/settings/page.tsx

---

# TICKET SUMMARY

| ID | Title | Pillar | Depends On |
|---|---|---|---|
| T-001 | Project Scaffolding — Monorepo, Next.js Frontend, Express Backend | INFRA | None |
| T-002 | Prisma + Supabase Database Connection Setup | INFRA | T-001 |
| T-003 | DB Migration — accounts Table | INFRA | T-002 |
| T-004 | DB Migration — properties Table | INFRA | T-003 |
| T-005 | DB Migration — bookings Table | INFRA | T-004 |
| T-006 | DB Migration — messages Table | INFRA | T-005 |
| T-007 | DB Migration — cleaners + property_cleaners Tables | INFRA | T-004 |
| T-008 | DB Migration — turnover_checklists Table + updated_at Trigger | INFRA | T-004 |
| T-009 | DB Migration — cleaning_jobs Table + Trigger + UNIQUE Constraint | INFRA | T-005, T-007, T-008 |
| T-010 | DB Migration — work_orders Table + Trigger + Partial Unique Index | INFRA | T-005, T-009 |
| T-011 | DB Migration — review_drafts Table + Trigger | INFRA | T-004, T-005 |
| T-012 | Supabase Row Level Security Policies — All Tables | INFRA | T-011 |
| T-013 | Application-Layer AES-256-GCM Encryption Prisma Middleware | INFRA | T-002 |
| T-014 | pino Logging + Sentry Error Tracking Setup | INFRA | T-001 |
| T-015 | pg-boss Worker Setup + All 10 Scheduled Job Registrations | INFRA | T-002, T-014 |
| T-016 | JWT Auth Middleware + token_version Revocation Check | INFRA | T-003, T-015 |
| T-017 | Account Isolation Middleware | INFRA | T-016 |
| T-018 | Rate Limiting + CORS Middleware | INFRA | T-001 |
| T-019 | POST /auth/login + POST /auth/logout | INFRA | T-016, T-018 |
| T-020 | POST /auth/forgot-password | INFRA | T-019 |
| T-021 | POST /auth/reset-password | INFRA | T-020 |
| T-022 | Webhook Endpoint Stubs — All 9 Routes with Signature Validation | INFRA | T-015, T-018 |
| T-023 | Feature 1.7 — Booking Sync Webhook Worker | 1 | T-022, T-005 |
| T-024 | Feature 1.7 — Booking Cancellation Behavior (Section 7.7) | 1 | T-023, T-009 |
| T-025 | Feature 1.6 — booking-activation-sweep + booking-sync-sweep Jobs | 1 | T-023, T-004, T-005 |
| T-026 | Feature 3.1 Trigger A — Work Order Creation Worker Function | 3 (placed before T-027) | T-010, T-006, T-014 |
| T-027 | Feature 1.1 + 1.4 — AI Inquiry Response Worker | 1 | T-022, T-026, T-003, T-005, T-006 |
| T-028 | Feature 1.2 — checkin-message-sweep Job | 1 | T-025, T-027 |
| T-029 | Feature 1.3 — checkout-reminder-sweep Job | 1 | T-025 |
| T-030 | Feature 1.5 — review-request-sweep Job | 1 | T-025 |
| T-031 | AI Token Cap Reset + Guest PII Retention Purge Daily Jobs | INFRA | T-015, T-003, T-006 |
| T-032 | PATCH /api/messages/:id — Manager Reply via Platform API | 1 | T-016, T-017, T-022, T-006 |
| T-033 | GET /api/messages + GET /api/bookings | 1 | T-016, T-017, T-006, T-005 |
| T-034 | GET /api/properties + POST /api/properties + GET /api/properties/:id | INFRA | T-016, T-017, T-004, T-008 |
| T-035 | PATCH /api/properties/:id | INFRA | T-034 |
| T-036 | POST /api/cleaners + PATCH /api/cleaners/:id + GET /api/cleaners | INFRA | T-007, T-016, T-017 |
| T-037 | PATCH /api/settings + GET /api/account + GET /api/search | INFRA | T-016, T-017, T-003 |
| T-038 | Twilio SMS Webhook Worker — Inbound SMS Routing Logic | 2 | T-022, T-007, T-009 |
| T-039 | Feature 2.1 — Auto-Schedule Cleaner | 2 | T-025, T-007, T-009, T-015 |
| T-040 | Feature 2.2 — Turnover Checklist Delivery (CONFIRM Handler) | 2 | T-038, T-008 |
| T-041 | Feature 2.3 — Completion Confirmation (DONE Handler) | 2 | T-038, T-040 |
| T-042 | Feature 2.4 — Supply Restocking Alert (LOW: Handler) | 2 | T-038 |
| T-043 | Feature 2.5 — cleaner-no-response-check Job | 2 | T-038, T-015 |
| T-044 | pre-checkin-alert-check Job | 2 | T-039, T-015 |
| T-045 | GET /api/cleaning-jobs + PATCH /api/cleaning-jobs/:id + PATCH /api/cleaning-jobs/:id/dismiss-damage | 2 | T-016, T-017, T-009 |
| T-046 | POST /api/work-orders — Manager-Initiated Work Order (Trigger B) | 3 | T-010, T-016, T-017 |
| T-047 | GET /api/work-orders + PATCH /api/work-orders/:id | 3 | T-046 |
| T-048 | Feature 3.2 — Review Response Webhook Worker | 3 | T-011, T-022, T-015 |
| T-049 | GET /api/review-drafts + PATCH /api/review-drafts/:id + POST /api/review-drafts/:id/retry | 3 | T-048, T-016, T-017 |
| T-050 | Login Screen + Forgot Password Screen (Screens 1 & 2) | INFRA | T-019, T-020, T-021 |
| T-051 | Global UI Infrastructure — Layout, Nav Bar, Session Interceptor, AI Cap Banner | INFRA | T-050 |
| T-052 | Global Search Component | INFRA | T-051, T-037 |
| T-053 | Dashboard Screen — All 7 Panels (Screen 3) | 1 | T-051, T-033, T-045, T-047, T-049 |
| T-054 | Property List Screen (Screen 4) | 1 | T-051, T-034 |
| T-055 | Add Property Screen (Screen 5) | 1 | T-051, T-034 |
| T-056 | Edit Property Screen (Screen 6) | 1 | T-051, T-035, T-036 |
| T-057 | Property Detail Screen (Screen 7) | 1 | T-051, T-033, T-034, T-045, T-047 |
| T-058 | Message Thread Screen (Screen 8) | 1 | T-051, T-032, T-033 |
| T-059 | Work Orders Screen (Screen 9) + Work Order Detail Modal (Screen 10) | 3 | T-051, T-047, T-046 |
| T-060 | Review Draft Modal (Screen 11) | 3 | T-051, T-049 |
| T-061 | Cleaners Screen (Screen 12) | 2 | T-051, T-036 |
| T-062 | Settings Screen (Screen 13) | INFRA | T-051, T-037 |
