/**
 * T-026 — Feature 3.1 Trigger A — Work Order Creation Worker Function
 *
 * Called synchronously from the AI inquiry response worker (T-027) when the AI
 * returns MAINTENANCE:[description]. Handles Steps 1–7 of PRD Section 8.2.
 */

import Anthropic from '@anthropic-ai/sdk';
import twilio from 'twilio';
import { WorkOrderPriority } from '@prisma/client';
import type { accounts, properties, bookings, messages } from '@prisma/client';

import prisma from '../lib/prisma';
import logger from '../lib/logger';

// ── Priority keyword table — PRD Section 8.1 ─────────────────────────────────
// Evaluated top-down; first matching tier wins.

const URGENT_KEYWORDS  = ['flood', 'no power', 'gas smell', 'gas leak', 'fire', 'smoke', 'locked out', "can't get in", 'cannot get in', 'emergency'];
const HIGH_KEYWORDS    = ['ac not working', 'no ac', 'air conditioning broken', 'no hot water', 'heater broken', 'heat not working', "toilet won't flush", 'toilet overflowing', 'no heat'];
const MEDIUM_KEYWORDS  = ['dishwasher broken', 'oven not working', 'tv not working', 'washer broken', 'dryer broken', 'light out', 'lightbulb out', "door won't lock", "window won't close"];
const LOW_KEYWORDS     = ['needs more towels', 'wi-fi slow', 'slow internet', 'cosmetic issue', 'minor scratch', 'needs extra', 'preference'];

/**
 * Classify maintenance priority from the raw guest message (PRD Section 8.1).
 * Matches case-insensitively. Highest matching tier wins. Default: medium.
 */
export function classifyPriority(rawGuestMessage: string): WorkOrderPriority {
  const lower = rawGuestMessage.toLowerCase();

  for (const kw of URGENT_KEYWORDS)  if (lower.includes(kw)) return 'urgent';
  for (const kw of HIGH_KEYWORDS)    if (lower.includes(kw)) return 'high';
  for (const kw of MEDIUM_KEYWORDS)  if (lower.includes(kw)) return 'medium';
  for (const kw of LOW_KEYWORDS)     if (lower.includes(kw)) return 'low';

  return 'medium';
}

// ── Message template builders ─────────────────────────────────────────────────

/** Guest acknowledgment template — PRD Section 8.2 Step 5. */
export function buildGuestAckMessage(
  guestFirstName: string,
  aiSummary: string,
  businessName: string,
): string {
  return (
    `Hi ${guestFirstName}! Thank you for letting us know about ${aiSummary}.\n` +
    "Our team has been notified and we'll work to get this resolved as quickly as possible.\n" +
    'We appreciate your patience and will follow up with you shortly.\n' +
    businessName
  );
}

/** Manager SMS template — PRD Section 8.2 Step 6. */
export function buildManagerSmsText(
  priorityLabel: string,
  propertyName: string,
  aiSummary: string,
  businessName: string,
): string {
  return (
    `MAINTENANCE ${priorityLabel}: ${propertyName}\n` +
    `Issue: ${aiSummary}\n` +
    'Reported by: Guest\n' +
    'Work order logged. Log in to manage.\n' +
    `- ${businessName}`
  );
}

/** Standard ESCALATE guest holding message — PRD Section 6.4. */
export function buildEscalateHoldingMessage(guestFirstName: string): string {
  return `Great question, ${guestFirstName} — let me check on that and get back to you very shortly!`;
}

/** Manager escalation alert — PRD Section 6.4. */
export function buildEscalateManagerAlert(
  guestFirstName: string,
  guestLastName: string,
  propertyName: string,
  messageContent: string,
  businessName: string,
): string {
  return (
    `QUESTION ESCALATED: Guest ${guestFirstName} ${guestLastName} at ${propertyName} ` +
    `asked: '${messageContent}'. Log in to respond.\n- ${businessName}`
  );
}

// ── External service helpers ──────────────────────────────────────────────────

/** Sleep for `ms` milliseconds. Used for Rule 3 retry delay. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a message to the guest via the appropriate platform API.
 *
 * NOTE (T-027 hook): The actual Airbnb/VRBO platform API client is built in T-027.
 * Until then this logs the outbound message. The function signature and retry
 * contract are final so T-027 can drop in the real implementation without
 * changing call sites.
 */
export async function sendPlatformMessage(
  account: accounts,
  booking: bookings,
  messageText: string,
  overrideSend?: (platform: string, guestId: string, text: string) => Promise<void>,
): Promise<void> {
  const send = overrideSend ?? defaultPlatformSend;

  try {
    await send(booking.platform, booking.guest_platform_id, messageText);
  } catch (firstErr) {
    logger.warn({ err: firstErr, bookingId: booking.id }, 'platform send failed — retrying in 60s (Rule 3)');
    await sleep(60_000);
    try {
      await send(booking.platform, booking.guest_platform_id, messageText);
    } catch (secondErr) {
      // Permanent failure after one retry — log and send manager SMS alert per Rule 3.
      logger.error({ err: secondErr, bookingId: booking.id }, 'platform send permanently failed after retry');
      const failureAlert =
        `SEND FAILURE: Could not deliver message to guest ${booking.guest_first_name} ` +
        `at [property]. Please message the guest manually.`;
      await trySendManagerSms(account, failureAlert).catch((smsErr: unknown) =>
        logger.error({ err: smsErr }, 'Rule 3 manager failure SMS also failed'),
      );
    }
  }
}

async function defaultPlatformSend(platform: string, guestPlatformId: string, text: string): Promise<void> {
  // Real Airbnb/VRBO API call implemented in T-027.
  // Log the intent so it appears in Railway logs during development.
  logger.info({ platform, guestPlatformId, textLength: text.length }, 'platform message send (stub — T-027 implements)');
}

/**
 * Send an SMS via Twilio with Rule 3 retry.
 * Failure after retry: logs and applies email fallback if alert_channel includes email.
 */
export async function sendManagerSms(
  account: accounts,
  body: string,
  overrideSend?: (to: string, from: string, text: string) => Promise<void>,
): Promise<void> {
  if (!account.twilio_phone_number || !account.manager_phone) {
    logger.warn({ accountId: account.id }, 'Twilio phone numbers not configured — skipping manager SMS');
    return;
  }

  const send = overrideSend ?? defaultSendSms;

  try {
    await send(account.manager_phone, account.twilio_phone_number, body);
  } catch (firstErr) {
    logger.warn({ err: firstErr, accountId: account.id }, 'manager SMS failed — retrying in 60s (Rule 3)');
    await sleep(60_000);
    try {
      await send(account.manager_phone, account.twilio_phone_number, body);
    } catch (secondErr) {
      logger.error({ err: secondErr, accountId: account.id }, 'manager SMS permanently failed after retry');
      // Email fallback per Rule 3 — implemented in T-027 email utility. Log for now.
      if (account.alert_channel === 'email' || account.alert_channel === 'both') {
        logger.warn({ accountId: account.id }, 'Rule 3 email fallback required — implement SendGrid in T-027');
      }
    }
  }
}

async function defaultSendSms(to: string, from: string, body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    logger.warn('Twilio credentials not set — skipping SMS send');
    return;
  }

  const client = twilio(sid, token);
  await client.messages.create({ body, from, to });
}

/** Best-effort manager SMS — used only in error paths, never throws. */
async function trySendManagerSms(account: accounts, body: string): Promise<void> {
  await sendManagerSms(account, body).catch(() => undefined);
}

// ── AI summary generation ─────────────────────────────────────────────────────

/**
 * Generate a one-sentence AI summary of the maintenance issue.
 * 10-second timeout. Falls back to truncating description to 100 chars (PRD Section 8.2 Step 3).
 */
export async function generateAiSummary(
  description: string,
  overrideCall?: (prompt: string) => Promise<string>,
): Promise<string> {
  const prompt =
    'Summarize the following maintenance issue in one sentence, under 20 words.\n' +
    'Be factual and specific. Do not invent details not present in the text.\n' +
    `Issue: ${description}`;

  const call = overrideCall ?? defaultAiCall;

  try {
    return await Promise.race([
      call(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI summary timeout')), 10_000),
      ),
    ]);
  } catch (err) {
    logger.warn({ err }, 'AI summary generation failed — using truncated description as fallback');
    return description.slice(0, 100);
  }
}

async function defaultAiCall(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected AI response type');
  return block.text.trim();
}

// ── Main exported function ────────────────────────────────────────────────────

export interface CreateWorkOrderInput {
  account: accounts;
  property: properties;
  booking: bookings;
  sourceMessage: messages;
  maintenanceDescription: string;
}

export type CreateWorkOrderResult =
  | { outcome: 'work_order_created'; workOrderId: string }
  | { outcome: 'duplicate_skipped' }
  | { outcome: 'escalated'; reason: 'empty_description' };

/** Overrideable external dependencies — used in tests to avoid real I/O. */
export interface CreateWorkOrderDeps {
  sendPlatformMessageFn?: (platform: string, guestId: string, text: string) => Promise<void>;
  sendSmsFn?: (to: string, from: string, text: string) => Promise<void>;
  aiCallFn?: (prompt: string) => Promise<string>;
}

/**
 * Feature 3.1 Trigger A — PRD Section 8.2 Steps 1–7.
 *
 * Called synchronously from the AI inquiry response worker when the AI returns
 * MAINTENANCE:[description]. The maintenanceDescription should already have the
 * "MAINTENANCE:" prefix stripped by the caller.
 */
export async function createWorkOrderFromAI(
  input: CreateWorkOrderInput,
  deps: CreateWorkOrderDeps = {},
): Promise<CreateWorkOrderResult> {
  const { account, property, booking, sourceMessage } = input;

  // ── Step 1: Validate description ─────────────────────────────────────────────
  const description = input.maintenanceDescription.trim();

  if (!description) {
    logger.warn({ messageId: sourceMessage.id }, 'MAINTENANCE description empty — routing to ESCALATE');

    // Execute the standard ESCALATE path per PRD Section 6.4.
    const holdingMsg = buildEscalateHoldingMessage(booking.guest_first_name);
    await sendPlatformMessage(account, booking, holdingMsg, deps.sendPlatformMessageFn);

    const managerAlert = buildEscalateManagerAlert(
      booking.guest_first_name,
      booking.guest_last_name,
      property.name,
      sourceMessage.content,
      account.business_name,
    );
    await sendManagerSms(account, managerAlert, deps.sendSmsFn);

    await prisma.messages.update({
      where: { id: sourceMessage.id },
      data: { status: 'escalated', is_urgent: false },
    });

    return { outcome: 'escalated', reason: 'empty_description' };
  }

  // ── Step 2: Classify priority ─────────────────────────────────────────────────
  const priority = classifyPriority(sourceMessage.content);

  // ── Step 3: Generate AI summary ───────────────────────────────────────────────
  const aiSummary = await generateAiSummary(description, deps.aiCallFn);

  // ── Step 4: Create work order ─────────────────────────────────────────────────
  let workOrderId: string | null = null;

  try {
    const workOrder = await prisma.work_orders.create({
      data: {
        account_id:           account.id,
        property_id:          property.id,
        booking_id:           booking.id,
        reported_by:          'guest',
        description:          description,
        ai_summary:           aiSummary,
        priority:             priority,
        status:               'open',
        source_message_id:    sourceMessage.id,
      },
      select: { id: true },
    });
    workOrderId = workOrder.id;
    logger.info({ workOrderId, priority, messageId: sourceMessage.id }, 'work order created');
  } catch (err: unknown) {
    // Unique constraint on source_message_id — discard INSERT silently, continue.
    const isPrismaUniqueViolation =
      err instanceof Error && (err as { code?: string }).code === 'P2002';
    if (!isPrismaUniqueViolation) throw err;
    logger.warn({ messageId: sourceMessage.id }, 'work order already exists for this message — skipping insert');
  }

  // ── Step 5: Send guest acknowledgment ─────────────────────────────────────────
  const guestAck = buildGuestAckMessage(booking.guest_first_name, aiSummary, account.business_name);
  await sendPlatformMessage(account, booking, guestAck, deps.sendPlatformMessageFn);

  // ── Step 6: Send manager notification per priority tier ───────────────────────
  if (priority === 'urgent' || priority === 'high') {
    const priorityLabel = priority.toUpperCase();
    const smsText = buildManagerSmsText(priorityLabel, property.name, aiSummary, account.business_name);
    await sendManagerSms(account, smsText, deps.sendSmsFn);
  }
  // Medium → in-app badge only (work order row in DB). Low → logged only. No SMS for either.

  // ── Step 7: Set maintenance_triggered ────────────────────────────────────────
  await prisma.messages.update({
    where: { id: sourceMessage.id },
    data: { maintenance_triggered: true },
  });

  return workOrderId
    ? { outcome: 'work_order_created', workOrderId }
    : { outcome: 'duplicate_skipped' };
}
