# VRM Agent — Product Requirements Document
*AI-Powered Vacation Rental Manager*

| Version | 0.4 — All Issues Resolved |
|---|---|
| Date | April 2026 |
| Status | Pillar 1 Validated │ Pillar 2 Validated │ Pillar 3 Validated │ QA Corrected v0.4 |
| Target Market | Florida — US vacation rental managers |

---

# Section 1 — Product Overview

## 1.1 What Is This Product?

VRM Agent is an AI-powered autonomous agent that acts as a full-time operational assistant for vacation rental property managers. It handles the three highest-pain, highest-frequency tasks in the job: communicating with guests around the clock, coordinating cleaning and property turnovers, and receiving and logging maintenance issues — all without requiring constant human intervention.

## 1.2 The Problem It Solves

Vacation rental managers today juggle 4–6 separate tools that don't talk to each other, spend 20–30 hours per week on repetitive operational tasks, and still miss things — a late cleaner, a guest question at 2am, a broken appliance that turns into a 1-star review. The agent replaces that fragmented, manual workflow with one intelligent system that runs the operations automatically.

## 1.3 Who Is It For?

**Primary user (MVP)**
Professional vacation rental property managers in Florida managing between 10 and 75 properties on platforms like Airbnb and VRBO.

**Secondary user (V2)**
Solo hosts managing 1–10 properties who currently do everything themselves.

## 1.4 Build Approach

The MVP builds one fully functional agent for one manager. The SaaS layer — multi-tenancy, subscription billing, onboarding wizard — is built after the core agent is validated. However, the data model must be SaaS-ready from day one. This means every database table includes an account_id foreign key so that adding multi-tenancy later requires no structural changes to the database or the core agent logic.

---

# Section 2 — Goals & Success Metrics

## 2.1 Business Goals

- Reach first paying customer within 90 days of launch
- Reach $64K ARR within 12 months (approximately 30 Pro customers at $179/month)
- Maintain monthly churn below 5%

## 2.2 Product Success Metrics

- Guest response time reduced to under 2 minutes (from industry average of hours)
- Cleaning crew dispatched within 5 minutes of checkout detection
- Zero missed turnover events per week per property
- Manager reports saving at least 15 hours per week within 30 days of use

---

# Section 3 — MVP Scope

The MVP contains exactly three pillars. Nothing outside these three pillars gets built until they are working perfectly.

| Pillar | Description |
|---|---|
| Pillar 1 — Guest Communication | 24/7 inquiry response, check-in messages, checkout reminders, mid-stay support, review requests |
| Pillar 2 — Cleaning & Turnover | Auto-schedule cleaners, checklist delivery, completion confirmation, supply alerts |
| Pillar 3 — Maintenance Intake | Issue logging, work order creation, review response drafting |

## 3.1 Explicitly Out of Scope for MVP

The following must not be built until the MVP is validated with paying customers:
- Dynamic pricing engine
- Multi-platform listing sync
- Owner financial reports
- Preventive maintenance scheduling
- Full vendor dispatch and tracking
- Guest vetting and fraud detection
- Regulatory compliance alerts
- Upsell messaging
- Direct booking website
- SaaS onboarding wizard, subscription billing, multi-tenant account management

---

# Section 4 — SaaS Readiness Constraints

These rules apply to every line of code written in this project without exception. The implementation must follow these before writing any feature.

## Rule 1 — No Hardcoding

Never hardcode any property data, business name, configuration value, message template, cleaner contact, or operational setting in the code. Every piece of data specific to a property or manager must be read from the database at runtime. The MVP runs one agent for one manager. The data model must be structured as if it will serve thousands of managers simultaneously — each row must belong to a specific account via an account_id foreign key.

## Rule 2 — Time Zone

All time calculations, all scheduled jobs, and all trigger evaluations use the America/New_York time zone (Eastern Time) for the MVP. No UTC. No system default. Eastern Time explicitly, everywhere. When storing timestamps in the database, store in UTC. When evaluating trigger conditions, convert to Eastern Time first, then evaluate. Exception: pure duration arithmetic (e.g., NOW() + INTERVAL '60 minutes') does not require timezone conversion — it is timezone-agnostic.

## Rule 3 — Retry Logic

If any outbound message fails to send via the Airbnb API, VRBO API, or Twilio SMS, the system retries once after 60 seconds. If the retry also fails, the system logs the failure with the full error, marks the message as FAILED in the database, and immediately sends an SMS alert to the manager:

> "SEND FAILURE: Could not deliver message to guest [Guest First Name] at [Property Name]. Please message the guest manually. Reason: [error summary]."

**Email fallback (system-wide):** If the SMS alert itself also fails after one retry, AND the account's alert_channel includes 'email' or 'both', the system attempts email delivery of the failure alert as a fallback. Log the channel that succeeded or failed. This email fallback applies to all Rule 3 failure alerts across all features.

## Rule 4 — Message Deduplication

Every inbound message from Airbnb or VRBO carries a unique platform message ID. Before processing any inbound message, the system checks whether that platform message ID already exists in the messages table. If it does, the message is discarded silently. If it does not, the system inserts the platform message ID immediately — before any AI processing — to prevent race conditions if the webhook fires twice simultaneously. For Twilio inbound SMS (Pillar 2), the Twilio MessageSid serves the same deduplication function against the cleaning_jobs.inbound_sms_sids array.

## Rule 5 — No Fabrication

The AI agent never fabricates information. If the answer to a guest's question is not present in the property profile stored in the database, the agent must use the escalation protocol. There is no exception to this rule.

## Rule 6 — AI Token Cap Daily Reset

A daily pg-boss scheduled job (ai-token-cap-reset) runs at 00:00 ET every day. It resets accounts.daily_ai_token_usage = 0 and sets accounts.ai_token_cap_reset_at = now() for all active accounts. This prevents permanent lockout after the cap is first reached.

---

# Section 5 — Database Schema

The implementation must create all tables and fields below before building any feature. All tables include account_id for SaaS readiness.

## 5.1 accounts

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| business_name | text |
| manager_phone | text — receives all SMS alerts |
| manager_email | text |
| alert_channel | enum: 'sms', 'email', 'both' |
| communication_tone | enum: 'casual', 'professional', 'luxury' |
| twilio_phone_number | text — E.164 format. The Twilio number used as FROM for all outbound SMS for this account. |
| airbnb_access_token | text (encrypted) — Architecture v0.2 addition |
| airbnb_refresh_token | text (encrypted) — Architecture v0.2 addition |
| vrbo_access_token | text (encrypted) — Architecture v0.2 addition |
| vrbo_refresh_token | text (encrypted) — Architecture v0.2 addition |
| token_version | integer, default 1 — Architecture v0.2 addition |
| daily_ai_token_usage | integer, default 0 — Architecture v0.2 addition |
| ai_token_daily_cap | integer, default 500000 — Architecture v0.2 addition |
| ai_token_cap_reset_at | timestamptz — Architecture v0.2 addition |
| data_region | text, default 'us' — Architecture v0.2 addition |
| password_hash | text |
| password_reset_token | text, nullable — Architecture v0.2 addition |
| password_reset_expires_at | timestamptz, nullable — Architecture v0.2 addition |
| created_at | timestamp with time zone |

## 5.2 properties

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| name | text — e.g. 'The Beach House' |
| address | text |
| checkin_time | time |
| checkout_time | time |
| door_access_instructions | text (encrypted) |
| parking_instructions | text |
| wifi_name | text |
| wifi_password | text (encrypted) |
| house_rules | text |
| amenities | text |
| local_recommendations | text |
| special_instructions | text |
| checkout_steps | text |
| checkin_message_template | text — editable per property |
| checkout_reminder_template | text — editable per property |
| review_request_template | text — editable per property |
| checkin_message_enabled | boolean, default true |
| checkout_reminder_enabled | boolean, default true |
| review_request_enabled | boolean, default true |
| checkin_message_hours_before | integer, default 24 |
| checkout_reminder_send_time | time, default 20:00 |
| review_request_hours_after | integer, default 2 |
| airbnb_listing_id | text |
| vrbo_listing_id | text |
| property_status | enum: 'unknown', 'guest_ready', 'occupied', 'needs_cleaning', default 'unknown' |
| auto_schedule_cleaner_enabled | boolean, default true |
| cleaner_confirmation_window_minutes | integer, default 60 |
| pre_checkin_alert_minutes | integer, default 30 |
| created_at | timestamp with time zone |

## 5.3 bookings

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| property_id | uuid, foreign key → properties.id |
| platform | enum: 'airbnb', 'vrbo' |
| platform_booking_id | text |
| guest_first_name | text |
| guest_last_name | text |
| guest_platform_id | text — guest's Airbnb or VRBO user ID for messaging |
| checkin_datetime | timestamp with time zone |
| checkout_datetime | timestamp with time zone |
| status | enum: 'upcoming', 'active', 'completed', 'cancelled' |
| checkin_message_sent | boolean, default false |
| checkin_message_sent_at | timestamp with time zone, nullable |
| checkout_reminder_sent | boolean, default false |
| checkout_reminder_sent_at | timestamp with time zone, nullable |
| review_request_sent | boolean, default false |
| review_request_sent_at | timestamp with time zone, nullable |
| created_at | timestamp with time zone |

## 5.4 messages

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| property_id | uuid, foreign key → properties.id |
| booking_id | uuid, foreign key → bookings.id |
| platform_message_id | text, unique — used for deduplication |
| direction | enum: 'inbound', 'outbound' |
| channel | enum: 'airbnb', 'vrbo', 'sms' |
| sender | enum: 'guest', 'agent', 'manager' |
| content | text |
| intent_classification | text, nullable — AI-assigned label |
| status | enum: 'auto_handled', 'escalated', 'failed', 'no_response_needed', 'processing', 'manager_handled' |
| is_urgent | boolean, default false — Set to true when URGENT_ESCALATE fires. Enables red (urgent) vs yellow (standard escalation) color-coding in Active Alerts dashboard panel. |
| escalation_reason | text, nullable |
| maintenance_triggered | boolean, default false |
| sent_at | timestamp with time zone |
| created_at | timestamp with time zone |

## 5.5 work_orders

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| property_id | uuid, foreign key → properties.id |
| booking_id | uuid, foreign key → bookings.id, nullable |
| reported_by | enum: 'guest', 'cleaner', 'manager' |
| description | text — original message or report |
| ai_summary | text — AI-generated one-sentence summary |
| priority | enum: 'urgent', 'high', 'medium', 'low' |
| status | enum: 'open', 'in_progress', 'resolved' |
| source_message_id | uuid, foreign key → messages.id, nullable |
| source_cleaning_job_id | uuid, foreign key → cleaning_jobs.id, nullable |
| resolved_at | timestamp with time zone, nullable |
| resolved_by | enum: 'manager', nullable |
| manager_notes | text, nullable |
| created_at | timestamp with time zone |
| updated_at | timestamp with time zone |

## 5.6 cleaners

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| name | text |
| phone | text — stored in E.164 format, enforced at insert time |
| email | text, nullable |
| is_active | boolean, default true |
| created_at | timestamp with time zone |

## 5.7 property_cleaners

Junction table. A property can have multiple cleaners; exactly one must be designated primary per property.

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| property_id | uuid, foreign key → properties.id |
| cleaner_id | uuid, foreign key → cleaners.id |
| is_primary | boolean, default false — exactly one row per property must be true (enforced by partial unique index) |
| created_at | timestamp with time zone |

## 5.8 turnover_checklists

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| property_id | uuid, foreign key → properties.id |
| checklist_body | text — full checklist with line breaks. Blank/whitespace treated as 'not configured'. |
| created_at | timestamp with time zone |
| updated_at | timestamp with time zone — maintained by database trigger |

## 5.9 cleaning_jobs

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| property_id | uuid, foreign key → properties.id |
| booking_id | uuid, foreign key → bookings.id — UNIQUE constraint |
| next_booking_id | uuid, foreign key → bookings.id, nullable |
| cleaner_id | uuid, foreign key → cleaners.id |
| status | enum: 'scheduled', 'confirmed', 'completed', 'no_response', 'failed' |
| scheduled_start | timestamp with time zone |
| deadline | timestamp with time zone, nullable |
| job_notification_sent | boolean, default false |
| job_notification_sent_at | timestamp with time zone, nullable |
| cleaner_confirmed_at | timestamp with time zone, nullable |
| checklist_sent | boolean, default false |
| checklist_sent_at | timestamp with time zone, nullable |
| completed_at | timestamp with time zone, nullable |
| closed_by | enum: 'cleaner_sms', 'manager_manual', nullable |
| completion_sms_raw | text, nullable |
| supply_flags | text[], nullable |
| supply_alert_sent | boolean, default false |
| supply_alert_sent_at | timestamp with time zone, nullable |
| supply_alert_dismissed | boolean, default false |
| supply_alert_permanently_failed | boolean, default false — Set true after Rule 3 retry also fails on the supply alert send. Dashboard shows a persistent warning for this job. |
| no_response_alert_sent | boolean, default false |
| pre_checkin_alert_sent | boolean, default false |
| inbound_sms_sids | text[], default '{}' |
| damage_fyi_sent | boolean, default false — Set true when damage keywords detected in completion SMS (Feature 2.3), BEFORE attempting to send the FYI alert. This flag means 'damage detected', not 'FYI sent successfully'. |
| damage_report_dismissed | boolean, default false |
| created_at | timestamp with time zone |
| updated_at | timestamp with time zone — maintained by database trigger |

## 5.10 Required Database Constraints and Indexes

```sql
-- Prevent duplicate cleaning jobs for the same checkout booking
ALTER TABLE cleaning_jobs ADD CONSTRAINT cleaning_jobs_booking_id_unique UNIQUE (booking_id);

-- Enforce exactly one primary cleaner per property
CREATE UNIQUE INDEX property_cleaners_one_primary_per_property
ON property_cleaners (property_id) WHERE is_primary = true;

-- updated_at trigger function (shared across tables)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cleaning_jobs_updated_at
BEFORE UPDATE ON cleaning_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER turnover_checklists_updated_at
BEFORE UPDATE ON turnover_checklists
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

## 5.11 Additional Database Constraints

```sql
-- Prevent duplicate work orders from the same source message
CREATE UNIQUE INDEX work_orders_source_message_id_unique
ON work_orders (source_message_id) WHERE source_message_id IS NOT NULL;

CREATE TRIGGER work_orders_updated_at
BEFORE UPDATE ON work_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER review_drafts_updated_at
BEFORE UPDATE ON review_drafts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

## 5.12 review_drafts

| Field | Type & Notes |
|---|---|
| id | uuid, primary key |
| account_id | uuid, foreign key → accounts.id |
| property_id | uuid, foreign key → properties.id |
| booking_id | uuid, foreign key → bookings.id, nullable — always NULL in MVP |
| platform | enum: 'airbnb', 'vrbo' |
| platform_review_id | text, unique — deduplication key |
| reviewer_name | text |
| rating | integer — value 1 through 5 |
| review_text | text, nullable — NULL if platform sends no written text |
| draft_response | text, nullable — NULL if AI generation failed |
| status | enum: 'pending', 'copied', 'dismissed' |
| no_review_text | boolean, default false |
| ai_failed | boolean, default false |
| created_at | timestamp with time zone |
| updated_at | timestamp with time zone — maintained by database trigger |

---

# Section 6 — Pillar 1: Guest Communication

**STATUS: Fully detailed and validated. Ready for development.**

Purpose: The agent handles all guest-facing communication automatically, from booking confirmation to post-stay review request.

## 6.1 Webhook Endpoints

**Guest Message Webhooks (Pillar 1)**
- POST /webhooks/airbnb/message — receives Airbnb guest message events
- POST /webhooks/vrbo/message — receives VRBO guest message events

Payload contains at minimum: platform_message_id, listing_id, guest_platform_user_id, message_text, timestamp.

**Booking Sync Webhooks**
- POST /webhooks/airbnb/booking — receives Airbnb booking creation, modification, and cancellation events
- POST /webhooks/vrbo/booking — receives VRBO booking creation, modification, and cancellation events

Payload contains at minimum: platform_booking_id, listing_id, guest_platform_user_id, guest_first_name, guest_last_name, checkin_datetime, checkout_datetime, status (active/cancelled). The bookings table is populated exclusively through these webhooks and their fallback scheduler (Feature 1.7).

> **CRITICAL:** Without booking-sync webhooks and the booking activation sweep (Features 1.6 and 1.7), no bookings rows exist in the database and the entire system cannot function. These must be built before any Pillar feature is tested end-to-end.

## 6.2 AI System Prompt Template

This prompt is constructed at runtime for every AI call. Every bracketed value is a database field — nothing is hardcoded.

```
You are the guest communication assistant for [accounts.business_name].
You respond on behalf of the property manager.
Your tone is [accounts.communication_tone].

Property information:
- Name: [properties.name]
- Address: [properties.address]
- Check-in time: [properties.checkin_time]
- Check-out time: [properties.checkout_time]
- Door access: [properties.door_access_instructions]
- Parking: [properties.parking_instructions]
- Wi-Fi name: [properties.wifi_name]
- Wi-Fi password: [properties.wifi_password]
- House rules: [properties.house_rules]
- Amenities: [properties.amenities]
- Local recommendations: [properties.local_recommendations]
- Special instructions: [properties.special_instructions]

Current guest: [bookings.guest_first_name]
Their check-in: [bookings.checkin_datetime — Eastern Time]
Their check-out: [bookings.checkout_datetime — Eastern Time]

Absolute rules:
1. Never invent information not listed above.
2. Always address the guest by first name.
3. If the answer is not in the property info: respond only with ESCALATE
4. Never share another guest's information.
5. Never promise refunds, exceptions, or policy changes.
6. If message contains: emergency, fire, smoke, gas, flood, no power, locked out
   --- respond only with: URGENT_ESCALATE
7. If guest reports a broken/malfunctioning item:
   respond only with: MAINTENANCE:[one sentence description]

Guest message: [raw message text]
```

## 6.3 AI Response Types

| AI Returns | System Action |
|---|---|
| Normal text response | Send to guest via platform API. Log as auto_handled. |
| ESCALATE | Send holding message to guest. Alert manager. Mark message as escalated (YELLOW in dashboard). |
| URGENT_ESCALATE | Send urgent holding message. Alert manager via SMS immediately regardless of alert_channel setting. Set messages.is_urgent = true. Mark RED in dashboard. |
| MAINTENANCE:[description] | Feature 3.1 is invoked automatically and synchronously. Feature 3.1 Step 5 sends the guest acknowledgment — there is no separate prior holding message on the MAINTENANCE path. Create work_order. Set maintenance_triggered = true. |

## 6.4 Feature 1.1 — 24/7 Inquiry Response

**Trigger:** Inbound webhook from Airbnb or VRBO.

**Processing Sequence:**
- DEDUPLICATION: Extract platform_message_id. If found in messages: discard. If not found: immediately insert row with status = 'processing' and platform_message_id stored before any AI processing.
- LOOKUP: Use listing_id to find property row. Find active booking matching property_id and guest_platform_id with status = 'active'. If no active booking found: log and escalate to manager.
- BUILD PROMPT: Construct system prompt using Section 6.2 template. All values from database. None hardcoded.
- CALL AI: Send prompt to AI model. Receive response.
- EVALUATE RESPONSE: Determine response type per Section 6.3 table.
- SEND: Send reply via platform API. Apply retry logic (Rule 3).
- LOG: Update messages row. Insert outbound row. Record intent_classification, status, sent_at. If URGENT_ESCALATE: set messages.is_urgent = true.

**Escalation Protocol:**
- *Guest receives:* "Great question, [first name] — let me check on that and get back to you very shortly!"
- *Manager receives via alert_channel:* "QUESTION ESCALATED: Guest [name] at [property] asked: '[message]'. Log in to respond."
- Message marked status = 'escalated', is_urgent = false. Appears YELLOW in dashboard Active Alerts.

**Urgent Escalation Protocol:**
- *Guest receives:* "We've received your message and our team is being contacted right now. We'll be with you as quickly as possible."
- *Manager receives SMS immediately:* "URGENT: Guest [name] at [property]: '[message]'. Please contact guest immediately."
- messages.is_urgent = true. Message appears RED at top of Active Alerts in dashboard.

## 6.5 Feature 1.2 — Check-In Message

**Trigger:** Hourly scheduler. Query bookings where: status = 'upcoming' AND checkin_message_sent = false AND checkin_datetime (Eastern) falls within NOW + (checkin_message_hours_before - 0.5h) to NOW + (checkin_message_hours_before + 0.5h).

**Last-Minute Booking Override:** If time between booking created_at and checkin_datetime is less than checkin_message_hours_before + 1 hour, send check-in message immediately upon booking creation.

**Default Template:**
```
Hi {{guest_first_name}}! We're so excited to welcome you to {{property_name}} tomorrow.
Here are your arrival details:
Check-in time: {{checkin_time}}
Address: {{address}}
Door access: {{door_access}}
Parking: {{parking}}
Wi-Fi: {{wifi_name}} / Password: {{wifi_password}}
A few things to keep in mind: {{house_rules}}
If you need anything before or during your stay, just reply to this message.
See you soon!
{{business_name}}
```

## 6.6 Feature 1.3 — Check-Out Reminder

**Trigger:** Hourly scheduler. Query bookings where: status = 'active' AND checkout_reminder_sent = false AND checkout_datetime date (Eastern) = tomorrow's date AND current Eastern time is between 19:30 and 21:00. Preferred send: 8:00pm. If no send by 21:00, log failure and alert manager.

**Default Template:**
```
Hi {{guest_first_name}}! Just a friendly reminder that check-out is tomorrow at {{checkout_time}}.
When you're ready to head out:
{{checkout_steps}}
Thank you so much for staying with us. If there's anything you need before you leave, just reply here.
Safe travels!
{{business_name}}
```

## 6.7 Feature 1.4 — Mid-Stay Support

**Trigger:** Any inbound message where the booking lookup finds status = 'active'.

**Maintenance Detection — Two Layers:**

**Layer 1 — Urgent Keyword Match (string match, no AI):** Scan raw message text (case-insensitive) BEFORE sending to AI. Trigger words: emergency, fire, smoke, gas smell, gas leak, flood, flooding, water everywhere, no power, power out, locked out, can't get in, cannot get in. If any match: immediately return URGENT_ESCALATE.

**Layer 2 — AI Maintenance Classification:** If no urgent keyword matched, send to AI with standard system prompt. Do NOT classify as maintenance if the guest is asking how to use something, paying a compliment, or reporting a preference vs. a malfunction.

**Manager Notification Tiers:**

| Priority | Notification Method |
|---|---|
| Urgent | SMS immediately + red alert in dashboard |
| High | SMS immediately + orange alert in dashboard |
| Medium | In-app yellow alert only. No SMS. |
| Low | Logged in dashboard only. No notification sent. |

## 6.8 Feature 1.5 — Post-Stay Review Request

**Trigger:** Hourly scheduler. Query bookings where: status = 'completed' AND review_request_sent = false AND checkout_datetime (Eastern) falls between NOW - 2.5 hours and NOW - 1.5 hours.

**API Constraint — Resolved:** Airbnb's messaging API does not reliably support outbound messages containing URLs from third-party apps. The review request message does not include a clickable link. This is the permanent approach for the MVP.

**Default Template:**
```
Hi {{guest_first_name}}! We hope you had a wonderful stay at {{property_name}}.
It was truly a pleasure hosting you.
If you have a moment, you can leave us a review directly in your {{platform}} app under your past trips — it means the world to us.
Thank you again, and we hope to welcome you back someday!
Warm regards,
{{business_name}}
```

## 6.9 Manager Dashboard — Pillar 1 Requirements

**Active Alerts Panel:** All messages rows where status = 'escalated' or status = 'failed', sorted by created_at descending. Color-coding: Red = is_urgent = true OR status = 'failed'. Yellow = status = 'escalated' AND is_urgent = false.

**Message Log per Property:** Chronological list of all messages. Color coded: GREEN = auto_handled, YELLOW = escalated (standard), RED = urgent escalation or failed, GRAY = no_response_needed.

**Booking Status Panel:** For each booking, show send status of all three automated messages as checkmarks or open circles.

## 6.10 Feature 1.6 — Booking Activation Sweep

> **CRITICAL FIX (ISSUE-02):** Without this, the bookings.status transition from 'upcoming' to 'active' never fires, breaking the entire mid-stay response path (Feature 1.4).

**Trigger:** Hourly pg-boss scheduled job: booking-activation-sweep.

**Processing Sequence:**
- Query bookings where status = 'upcoming' AND checkin_datetime <= NOW().
- For each result: perform atomic conditional update: UPDATE bookings SET status = 'active' WHERE id = [id] AND status = 'upcoming'. If 0 rows affected: discard silently.
- For each successfully activated booking: set properties.property_status = 'occupied' in same transaction.
- Log each activation: booking_id, property_id, activated_at.

## 6.11 Feature 1.7 — Booking Sync

> **CRITICAL FIX (ISSUE-03):** Without this, no booking rows exist and the system cannot function.

**Trigger:** Inbound webhook: POST /webhooks/airbnb/booking or POST /webhooks/vrbo/booking.

**Processing Sequence — Booking Creation / Update:**
- Extract booking data from payload.
- Use listing_id to resolve property_id and account_id. If no match: log, return HTTP 200, discard.
- Upsert into bookings on (account_id, platform, platform_booking_id). New bookings receive status = 'upcoming'.
- If incoming event is a cancellation: route to Section 7.7 Booking Cancellation Behavior.
- Return HTTP 200.

**Fallback Scheduler:** A booking-sync-sweep hourly pg-boss job polls the platform APIs for bookings created or modified in the last 2 hours that were not received via webhook.

---

# Section 7 — Pillar 2: Cleaning & Turnover Coordination

**STATUS: Fully detailed and validated. Ready for development.**

Purpose: Every time a guest checks out, the agent automatically dispatches the assigned cleaning crew, delivers a room-by-room checklist, monitors for completion confirmation, and flags supply shortages — all without manual coordination from the manager.

## 7.1 Inbound SMS Webhook

All cleaner SMS replies are received at: POST /webhooks/twilio/sms

Twilio payload fields used: MessageSid, From (cleaner phone in E.164), Body (message text).

Required response: HTTP 200 with Content-Type: text/xml and body `<?xml version="1.0"?><Response/>`.

**Processing Sequence:**
- DEDUPLICATION: Extract MessageSid. Query cleaning_jobs where inbound_sms_sids contains MessageSid AND created_at >= NOW() - INTERVAL '7 days'. If found: discard silently.
- Look up cleaners row where phone = From AND is_active = true. If not found: log, discard.
- **MULTI-JOB GUARD:** An 'open' job is defined as status IN ('scheduled', 'confirmed', 'no_response'). If cleaner has more than one open job: append MessageSid to relevant job's inbound_sms_sids, send manager alert (template below), return HTTP 200.
- If exactly one open job found: append MessageSid to cleaning_jobs.inbound_sms_sids immediately.
- If no open job found: log orphaned SMS, discard.
- **ROUTE:** Trim all leading and trailing whitespace from Body. Lowercase. (a) If equals 'confirm', or starts with 'confirm ' or 'confirm,': route to Feature 2.2. (b) If equals 'done', or starts with 'done ' or 'done,': route to Feature 2.3. (c) If starts with 'low:': route to Feature 2.4. (d) None of the above: Unrecognized — log and discard.

**Multi-Job Guard Manager Alert Template:**
```
MULTI-JOB CONFLICT: {{cleaner_name}} ({{cleaner_phone}}) replied to a turnover SMS but has {{open_job_count}} open jobs: {{property_list}}
Their reply could not be auto-routed. Please contact them directly and close the correct job manually in the dashboard.
- {{business_name}}
```

| Variable | Source |
|---|---|
| {{cleaner_name}} | cleaners.name |
| {{cleaner_phone}} | cleaners.phone |
| {{open_job_count}} | count of open cleaning_jobs for this cleaner |
| {{property_list}} | comma-separated properties.name for each open job |
| {{business_name}} | accounts.business_name |

## 7.2 Feature 2.1 — Auto-Schedule Cleaner

**Triggers:**
- **Trigger A — Platform checkout webhook:** POST /webhooks/airbnb/checkout and POST /webhooks/vrbo/checkout
- **Trigger B — Hourly scheduler:** Bookings where status = 'active' AND checkout_datetime <= NOW() AND checkout_datetime >= NOW() - INTERVAL '24 hours' AND no cleaning_jobs row exists.

**Note on property_status = 'occupied':** The 'occupied' status is set by Feature 1.6 (Booking Activation Sweep). It is NOT set by Feature 2.1.

**Processing Sequence:**
- Detect checkout via path A (webhook) or path B (scheduler).
- Atomic conditional update: UPDATE bookings SET status = 'completed' WHERE id = [id] AND status = 'active'. If 0 rows affected: discard entirely.
- Set properties.property_status = 'needs_cleaning'.
- Check auto_schedule_cleaner_enabled. If false: skip, log, halt.
- Look up primary cleaner. Verify is_active = true. If not found or inactive: send manager alert, log, halt.
- Look up next upcoming booking. Set deadline = next_booking.checkin_datetime (NULL if none).
- Attempt INSERT into cleaning_jobs with status = 'scheduled'. If UNIQUE constraint fails: discard silently.
- Build and send job notification SMS to cleaner via Twilio. Apply retry logic (Rule 3).
- On success: set job_notification_sent = true, job_notification_sent_at = now().

**SMS Template — Feature 2.1:**
```
Hi {{cleaner_name}}, turnover job at {{property_name}}.
Address: {{property_address}}
Guest checkout: {{checkout_time_eastern}}
{{next_checkin_line}}
Reply CONFIRM to accept.
- {{business_name}}
```

## 7.3 Feature 2.2 — Turnover Checklist Delivery

**Trigger:** Inbound SMS routed from Section 7.1 where message body routes to 'confirm' and cleaning_jobs row has status = 'scheduled' or 'no_response'.

**Processing Sequence:**
- Verify status IN ('scheduled', 'no_response'). If already 'confirmed' AND checklist_sent = true: discard.
- Set status = 'confirmed', cleaner_confirmed_at = now().
- Look up turnover_checklists. If no row or checklist_body is blank: alert manager, log, halt checklist send only.
- Build and send checklist SMS via Twilio. Apply retry logic (Rule 3).
- On success: set checklist_sent = true, checklist_sent_at = now().

## 7.4 Feature 2.3 — Completion Confirmation

**Trigger:** Inbound SMS where message body routes to 'done' and cleaning_jobs row has status IN ('scheduled', 'confirmed').

**Processing Sequence:**
- Verify status IN ('scheduled', 'confirmed'). If status = 'completed': discard silently.
- **In a single transaction:** set status = 'completed', completed_at = now(), closed_by = 'cleaner_sms', completion_sms_raw = [raw Body].
- Set properties.property_status = 'guest_ready'.
- Check if Body contains 'low:' after 'done'. If yes: execute Feature 2.4 sequentially after this step.
- **Damage keyword scan:** Scan Body (after stripping DONE and LOW: content) for damage keywords: broken, damaged, cracked, shattered, not working, doesn't work, won't work, leak, leaking, flooded, flooding, stain, stained, burn, burned, torn, missing, hole.
  - **If any match: immediately set cleaning_jobs.damage_fyi_sent = true in the SAME TRANSACTION as the status update in Step 2 — BEFORE attempting to send the FYI alert.** Then attempt to send the Cleaner Damage FYI alert. If alert send fails: log — dashboard still shows damage report because damage_fyi_sent is already true.
- Send completion acknowledgment SMS to cleaner. Apply retry logic (Rule 3).
- Send completion notification to manager via alert_channel. Apply retry logic (Rule 3).

> **Manager Manual Closure (ISSUE-18 fix):** When a manager manually closes a job via the dashboard (PATCH /api/cleaning-jobs/[id] with closed_by = 'manager_manual'), the API must also set properties.property_status = 'guest_ready' in the same transaction.

**Pre-Check-In Alert Templates (ISSUE-22 fix):**

**Standard alert (deadline >= NOW()):**
```
ALERT: {{cleaner_name}} has not yet confirmed completion for {{property_name}}. Next guest checks in at {{next_checkin_eastern}}. Please confirm the property is ready. - {{business_name}}
```

**Overdue variant (deadline < NOW()):**
```
OVERDUE ALERT: Cleaning deadline has passed for {{property_name}}. Next guest check-in at {{next_checkin_eastern}} is at risk. Please verify property status immediately. - {{business_name}}
```

## 7.5 Feature 2.4 — Supply Restocking Alert

**Triggers:** (A) Combined with DONE: message starts with 'DONE' and contains 'LOW:'. (B) Standalone: message starts with 'LOW:' and matched job has status = 'confirmed'.

**Processing Sequence:**
- Extract text after first occurrence of 'LOW:' (case-insensitive). Split on commas. Trim whitespace. Discard empty tokens. Normalize to lowercase.
- If 0 items parsed: send generic supply alert. Set supply_alert_sent = true. Log. Halt.
- Merge parsed items into supply_flags (deduplicated by lowercase match).
- Build and send supply alert to manager via alert_channel. Apply retry logic (Rule 3).
- On successful delivery: set supply_alert_sent = true, supply_alert_sent_at = now().
- **On permanent failure (retry also fails):** set supply_alert_permanently_failed = true.

## 7.6 Feature 2.5 — Cleaner No-Response Check

> **CRITICAL FIX (ISSUE-04):** Without this, the 'no_response' status transition never fires.

**Trigger:** Hourly pg-boss scheduled job: cleaner-no-response-check. Query: cleaning_jobs where status = 'scheduled' AND job_notification_sent = true AND cleaner_confirmed_at IS NULL AND job_notification_sent_at <= NOW() - INTERVAL '[cleaner_confirmation_window_minutes] minutes' AND no_response_alert_sent = false.

**Processing Sequence:**
- Atomic conditional update: UPDATE cleaning_jobs SET status = 'no_response' WHERE id = [id] AND status = 'scheduled'. If 0 rows affected: discard.
- Send manager alert via alert_channel. Apply retry logic (Rule 3).
- Set no_response_alert_sent = true.

**Manager Alert Template (SMS):**
```
NO RESPONSE: {{cleaner_name}} has not confirmed the turnover job at {{property_name}}.
Guest checkout was {{checkout_time_eastern}}.
Please contact {{cleaner_name}} directly at {{cleaner_phone}}, or assign a replacement and close the job manually in the dashboard.
- {{business_name}}
```

**Manager Alert Template (Email — when alert_channel = 'email' or 'both'):**
**Subject:** No Response: {{cleaner_name}} — {{property_name}}
Body: Same content as SMS template above, with closing line: "Log in to VRM Agent to manage this job."

| Variable | Source |
|---|---|
| {{cleaner_name}} | cleaners.name |
| {{cleaner_phone}} | cleaners.phone |
| {{property_name}} | properties.name |
| {{checkout_time_eastern}} | bookings.checkout_datetime (Eastern Time) |
| {{business_name}} | accounts.business_name |

## 7.7 Booking Cancellation Behavior

> **ISSUE-27 FIX:** Specifies behavior when a booking-sync webhook delivers a cancellation event.

**Case A — Booking status = 'upcoming' at cancellation:**
- Set bookings.status = 'cancelled'. No cleaning_jobs row exists — no further action.
- No guest communication is sent.

**Case B — Booking status = 'active' at cancellation (mid-stay):**
- Set bookings.status = 'cancelled'.
- If a cleaning_jobs row exists for this booking_id with status IN ('scheduled', 'confirmed', 'no_response'): set cleaning_jobs.status = 'failed'.
- Set properties.property_status = 'unknown'.
- Send manager alert via alert_channel:

```
BOOKING CANCELLED: Guest {{guest_first_name}} {{guest_last_name}} at {{property_name}} cancelled mid-stay. Any pending cleaning job has been marked failed. Please verify property status and manage manually. - {{business_name}}
```

**Case C — Booking status = 'completed' at cancellation:**
Discard the cancellation event silently. Log the event.

## 7.8 Manager Dashboard — Pillar 2 Requirements

**Turnover Status Panel:**

| property_status value | Display Label | Badge Color |
|---|---|---|
| guest_ready | GUEST READY | Green |
| occupied | OCCUPIED | Blue |
| needs_cleaning | NEEDS CLEANING | Orange |
| unknown | UNKNOWN | Gray |

| cleaning_jobs.status | Display Label | Badge Color |
|---|---|---|
| scheduled | Awaiting Confirm | Yellow |
| confirmed | Confirmed | Blue |
| completed | Complete | Green |
| no_response | No Response | Red |
| failed | Failed | Red |

---

# Section 8 — Pillar 3: Maintenance Intake

**STATUS: Fully detailed and validated. Ready for development.**

Purpose: When something breaks or a guest reports a problem, the agent creates a structured record of the issue, acknowledges the guest, and notifies the manager. When guests leave reviews, the agent drafts a response for the manager to post manually.

## 8.1 Priority Classification Logic

Keywords are matched case-insensitively against the original raw guest message text for Trigger A. The highest-matching tier wins. Tiers are evaluated top-down. If no keyword matches, priority defaults to Medium.

| Priority | Trigger Keywords |
|---|---|
| Urgent | flood, no power, gas smell, gas leak, fire, smoke, locked out, can't get in, cannot get in, emergency |
| High | AC not working, no AC, air conditioning broken, no hot water, heater broken, heat not working, toilet won't flush, toilet overflowing, no heat |
| Medium | dishwasher broken, oven not working, TV not working, washer broken, dryer broken, light out, lightbulb out, door won't lock, window won't close |
| Low | needs more towels, Wi-Fi slow, slow internet, cosmetic issue, minor scratch, needs extra, preference |

Default: If no keyword from any tier matches, priority = Medium.

## 8.2 Feature 3.1 — Issue Logging & Work Order Creation

**Triggers:**
- **Trigger A — AI Maintenance Classification:** When the AI returns MAINTENANCE:[description] during Feature 1.4 processing, Feature 3.1 is invoked automatically and synchronously. Feature 3.1 Step 5 sends the guest acknowledgment (no prior holding message is sent).
- **Trigger B — Cleaner Damage Report:** When damage keywords are detected in Feature 2.3, cleaning_jobs.damage_fyi_sent is set to true immediately. The Damage Reports panel surfaces the record with a Create Work Order button.

> **CONSTRAINT:** No work_orders row is auto-created from cleaner messages in MVP. Auto-routing from Pillar 2 to Feature 3.1 without manager action is V2.

**Processing Sequence — Trigger A (Automated, from AI):**

**Step 1 — Extract and Validate Description:** Parse MAINTENANCE:[description]. Strip prefix. Trim. If empty/whitespace: escalate via standard ESCALATE path; do NOT create a work order.

**Step 2 — Classify Priority:** Scan messages.content (original raw guest message) against Section 8.1 keyword table. Assign highest matching tier. Default: Medium.

**Step 3 — Generate AI Summary:**
```
Summarize the following maintenance issue in one sentence, under 20 words.
Be factual and specific. Do not invent details not present in the text.
Issue: [extracted description from step 1]
```
Failure fallback: truncate raw description to 100 characters.

**Step 4 — Create Work Order:** Insert into work_orders with reported_by = 'guest', status = 'open', source_message_id. If UNIQUE constraint on source_message_id: discard INSERT silently, continue to Step 5.

**Step 5 — Send Guest Acknowledgment:** Send template below to guest via platform API. Apply Rule 3.

**Step 6 — Send Manager Notification:** Per priority tier table. Apply Rule 3.

**Step 7 — Log:** Set messages.maintenance_triggered = true.

**Processing Sequence — Trigger B (Manager-Initiated, from Cleaner Damage FYI):**

Step 1 — Display in Damage Reports Panel. Step 2 — Strip raw message (remove DONE, LOW: content). Step 3 — Manager opens form modal pre-populated with cleaned text. Step 4 — Generate AI Summary (same prompt, failure fallback). Step 5 — Manager submits: reported_by determined SERVER-SIDE: if source_cleaning_job_id non-null -> 'cleaner'; else -> 'manager'. **Client NEVER passes reported_by in request body.** Step 6 — No guest acknowledgment. Step 7 — No manager notification.

**Guest Acknowledgment Message (Trigger A only):**
```
Hi {{guest_first_name}}! Thank you for letting us know about {{ai_summary}}.
Our team has been notified and we'll work to get this resolved as quickly as possible.
We appreciate your patience and will follow up with you shortly.
{{business_name}}
```

**Manager Notification per Priority Tier (Trigger A only):**

| Priority | Notification Method |
|---|---|
| Urgent | SMS immediately + red badge in dashboard |
| High | SMS immediately + orange badge in dashboard |
| Medium | In-app yellow badge only. No SMS. |
| Low | Logged in dashboard only. No badge, no notification. |

**SMS Template (Urgent / High):**
```
MAINTENANCE {{priority_label}}: {{property_name}}
Issue: {{ai_summary}}
Reported by: Guest
Work order logged. Log in to manage.
- {{business_name}}
```

**Work Order Status Lifecycle:**

| Status | Meaning | Set By |
|---|---|---|
| open | Issue received and logged. No action taken yet. | System at creation |
| in_progress | Manager acknowledged and actively working on resolution. | Manager via dashboard |
| resolved | Issue has been resolved. | Manager via dashboard |

**Dashboard Display — Damage Reports Panel:**
```sql
SELECT cj.* FROM cleaning_jobs cj
WHERE cj.damage_fyi_sent = true
AND cj.damage_report_dismissed = false
AND NOT EXISTS (
  SELECT 1 FROM work_orders wo
  WHERE wo.source_cleaning_job_id = cj.id
)
ORDER BY cj.completed_at DESC
```

## 8.3 Feature 3.2 — Review Response Drafting

**How the Agent Detects a New Review:**
- POST /webhooks/airbnb/review
- POST /webhooks/vrbo/review

Payload fields used: platform_review_id, listing_id, reviewer_name, rating (integer 1–5), review_text, timestamp.

**Deduplication:** Check review_drafts.platform_review_id. If found: discard. If not found: proceed.

**Property Lookup:** Use listing_id to find property. If not found: log, discard.

**Empty Review Text Handling:** If review_text is NULL or empty: set draft_response to static fallback template; set no_review_text = true; skip AI call.

Static fallback:
```
Thank you so much for staying at {{property_name}} and for taking the time to leave a review, {{reviewer_name}}!
We hope you enjoyed your stay and would love to welcome you back.
{{business_name}}
```

**Rating Classification:** Rating >= 4 → positive prompt. Rating <= 3 → negative/neutral prompt. **A 3-star review uses the negative/neutral prompt.**

**Positive Review Prompt (rating >= 4):**
```
You are drafting a review response on behalf of {{business_name}}.
Your tone is {{communication_tone}}.
Property: {{property_name}}
Reviewer name: {{reviewer_name}}
Star rating: {{rating}} out of 5
Review text: {{review_text}}

Write a warm, genuine response. Keep it under 150 words.
Rules:
1. Address the reviewer by first name if determinable; otherwise use full name.
2. Thank them sincerely for their stay and for taking the time to review.
3. Reference one specific detail from the review if possible. Do not invent details.
4. Invite them to return.
5. Sign off with {{business_name}}.
6. Never fabricate information not present in the review text.
```

**Negative / Neutral Review Prompt (rating <= 3):**
```
You are drafting a review response on behalf of {{business_name}}.
Your tone is {{communication_tone}}.
Property: {{property_name}}
Reviewer name: {{reviewer_name}}
Star rating: {{rating}} out of 5
Review text: {{review_text}}

Write a professional, constructive response. Keep it under 150 words.
Rules:
1. Address the reviewer by first name if determinable; otherwise use full name.
2. Thank them for their feedback.
3. Acknowledge their experience without being defensive.
4. Apologize briefly and professionally for any shortcoming they described.
5. Use general language about addressing feedback. Do not make specific promises. Never promise refunds or compensation.
6. Invite them to contact {{business_name}} directly to discuss further.
7. Sign off with {{business_name}}.
8. Never fabricate information not in the review text.
```

**AI Draft Failure Fallback:** Insert review_drafts row with draft_response = NULL, status = 'pending', ai_failed = true.

**Manager Notification — New Review Received:**
```
NEW REVIEW: {{reviewer_name}} left a {{rating}}-star review at {{property_name}}.
Draft response is ready in VRM Agent. Log in to review and post.
- {{business_name}}
```

**Email Subject:** New {{rating}}-star review at {{property_name}} — draft response ready

**Posting Limitation (permanent for MVP):** Airbnb and VRBO do not allow third-party applications to auto-post review responses via API. The manager must copy the draft and paste it manually. No auto-posting code is to be built for MVP.

## 8.4 SaaS Readiness Constraints — Pillar 3 Compliance

| Rule | Pillar 3 Implementation |
|---|---|
| 1. No Hardcoding | All property names, business names, communication tones, and message templates read from the database at runtime. All SMS templates use {{business_name}} — never a hardcoded app name. |
| 2. Time Zone | All dashboard timestamps displayed in Eastern Time. All stored timestamps in UTC. |
| 3. Retry Logic | Applies to guest acknowledgment (Trigger A), manager SMS notifications (Urgent/High), and review notification SMS. Each retries once after 60 seconds. Email fallback applies where alert_channel includes email. |
| 4. Deduplication | platform_review_id unique in review_drafts. Unique partial index on work_orders.source_message_id prevents duplicate work orders from the same source message. |
| 5. No Fabrication | AI summary prompt and both review prompts include explicit rules prohibiting invented information. |

---

# Section 9 — Integrations Required for MVP

| Integration | Purpose | Required for MVP? |
|---|---|---|
| Airbnb Messaging API | Sync bookings, receive/send guest messages, receive review events | Yes |
| VRBO Messaging API | Sync bookings, receive/send guest messages, receive review events | Yes |
| Twilio SMS | Send/receive SMS to cleaners and managers | Yes |
| SendGrid | Send manager alerts by email | Yes |
| Anthropic API | AI message classification, response generation, intent detection | Yes |
| WhatsApp Business API | Alternative contact channel for cleaners | Optional — V2 |

> **AI DATA PRIVACY — LAUNCH PREREQUISITE:** The AI system prompt transmits sensitive guest and property data to the Anthropic API. Before launch: (1) Verify the Anthropic API data processing agreement covers this use case. (2) Confirm that API inputs are not used for model training. (3) Document the AI provider as a data processor in Terms of Service and Privacy Policy. This is a launch prerequisite and must not be deferred.

> **RESOLVED: Airbnb Review Link Constraint** — The review request message (Feature 1.5) does not include a clickable link. Guests are directed to find the review section in their Airbnb app under past trips. No link version is to be built.

---

# Section 10 — Open Questions & Decisions

| Question | Status | Answer / Decision |
|---|---|---|
| Web app, mobile app, or both? | RESOLVED | Web app first. |
| Database / data store? | RESOLVED (Arch) | PostgreSQL on Supabase. |
| Authentication method? | RESOLVED (Arch) | Email + password; JWT in HTTP-only cookie with token_version revocation. |
| Airbnb & VRBO API access | OPEN | Developer accounts required before build begins. |
| Cleaner communication — SMS or WhatsApp? | RESOLVED | SMS via Twilio for MVP. |
| Hosting platform? | RESOLVED (Arch) | Vercel (frontend) + Railway (backend + pg-boss worker). |
| AI model — Claude or GPT-4? | RESOLVED (Arch) | Claude Sonnet 4 (claude-sonnet-4-20250514). |
| Frontend framework? | RESOLVED (Arch) | Next.js (React) with TypeScript. |
| Airbnb review link in messages? | RESOLVED | No link. Direct guests to Airbnb app under past trips. |
| 'Save as future answer' feature? | RESOLVED | OUT OF SCOPE for MVP. V2. |
| Time zone standard? | RESOLVED | All time calculations use America/New_York (Eastern Time). Store in UTC, evaluate in Eastern. |
| Cleaner with multiple simultaneous open jobs? | RESOLVED | System cannot auto-route SMS reply if cleaner has >1 open job. Manager alert fires. |
| Non-primary cleaners — automated use? | RESOLVED | Non-primary cleaners are informational only in MVP. No auto-dispatch to backup cleaners. |
| Cleaner-to-work-order auto-routing? | RESOLVED | No work_orders row auto-created from cleaner messages in MVP. Manager creates manually. |
| Work order booking_id linkage from reviews? | RESOLVED | booking_id always NULL on review_drafts in MVP. |
| Rating 3 — positive or negative prompt? | RESOLVED | 3-star reviews use the negative/neutral prompt. |
| Booking 'upcoming' → 'active' transition trigger? | RESOLVED | Hourly pg-boss job: booking-activation-sweep (Feature 1.6). |
| Booking sync / how do bookings enter the system? | RESOLVED | POST /webhooks/airbnb/booking and POST /webhooks/vrbo/booking (Feature 1.7). |
| Cleaner no-response feature spec? | RESOLVED | Feature 2.5 (Section 7.6). |
| AI token cap daily reset job? | RESOLVED | Rule 6 (Section 4) — ai-token-cap-reset pg-boss daily job at 00:00 ET. |
| Checkout webhook endpoints? | OPEN (Arch gap) | Architecture v0.2 adds POST /webhooks/airbnb/checkout and /vrbo/checkout. |
| Password reset token flow? | RESOLVED | Custom columns approach per Architecture Section 4.5 and Screens Section 7. |

---

# Section 11 — Document Status & Next Steps

| Section | Status |
|---|---|
| Section 1 — Product Overview | Complete |
| Section 2 — Goals & Metrics | Complete |
| Section 3 — MVP Scope | Complete |
| Section 4 — SaaS Readiness Constraints | Complete (Rule 3 email fallback added v0.4, Rule 6 AI cap reset added v0.4) |
| Section 5 — Database Schema | Complete for Pillars 1, 2 & 3 |
| Section 6 — Pillar 1: Guest Communication | FULLY DETAILED & VALIDATED |
| Section 7 — Pillar 2: Cleaning & Turnover | FULLY DETAILED & VALIDATED |
| Section 8 — Pillar 3: Maintenance Intake | FULLY DETAILED & VALIDATED |
| Section 9 — Integrations | Complete |
| Section 10 — Open Questions | Updated |
| Section 11 — Next Steps | This section |

## v0.4 Corrections Summary

- CRITICAL: messages.is_urgent boolean added — enables red/yellow dashboard differentiation (ISSUE-01)
- CRITICAL: Feature 1.6 (Booking Activation Sweep) added — defines upcoming→active transition (ISSUE-02)
- CRITICAL: Feature 1.7 (Booking Sync) and booking-sync webhook endpoints added (ISSUE-03)
- CRITICAL: Feature 2.5 (Cleaner No-Response Check) fully specified (ISSUE-04)
- HIGH: Feature 2.1 Trigger A flagged as Architecture dependency for checkout webhooks (ISSUE-05)
- HIGH: Rule 6 AI Token Cap Reset job specified in Section 4 (ISSUE-06)
- HIGH: SMS templates corrected from hardcoded '- VRM Agent' to '{{business_name}}' (ISSUE-09)
- HIGH: reported_by determination clarified as server-side in Feature 3.1 Trigger B Step 5 (ISSUE-10)
- MEDIUM: MAINTENANCE path clarified — no separate holding message (ISSUE-17)
- MEDIUM: Manager manual job close specified to also set property_status = 'guest_ready' (ISSUE-18)
- MEDIUM: Section 7.1 SMS routing definition made precise (ISSUE-20)
- MEDIUM: Rule 3 updated with email fallback as system-wide standard (ISSUE-21)
- MEDIUM: Pre-check-in alert SMS templates (standard and overdue) added to Section 7.4 (ISSUE-22)
- MEDIUM: supply_alert_permanently_failed behavior specified (ISSUE-23)
- MEDIUM: property_status = 'occupied' trigger defined (Feature 1.6 activation sweep) (ISSUE-24)
- MEDIUM: Section 7.7 Booking Cancellation Behavior added (ISSUE-27)
- MEDIUM: Multi-job guard alert template and 'open' job definition added to Section 7.1 (ISSUE-28)
- MEDIUM: damage_fyi_sent decoupled from alert send success in Section 5.9 and Feature 2.3 (ISSUE-29)
- MEDIUM: AI data privacy launch prerequisite note added to Section 9 (ISSUE-30)

> **Critical reminder for every new session:** Always paste the current version of this document (PRD v0.4) at the start of every new Claude conversation. Never rely on Claude's memory of previous sessions. The document is the source of truth.
