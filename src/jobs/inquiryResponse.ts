/**
 * T-027 — Feature 1.1 + 1.4 — AI Inquiry Response Worker
 *
 * THREE RULES — ordering is enforced by code structure:
 *   Rule A: Deduplication INSERT happens before any AI work.
 *   Rule B: Layer 1 urgent keyword scan happens before any AI call.
 *   Rule C: System prompt is built entirely from DB values — zero hardcoded
 *            business names, property data, or operational values.
 */

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { formatInTimeZone } from 'date-fns-tz';
import type { accounts, properties, bookings } from '@prisma/client';

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import {
  sendPlatformMessage,
  sendManagerSms,
  buildEscalateHoldingMessage,
  buildEscalateManagerAlert,
  createWorkOrderFromAI,
  type CreateWorkOrderDeps,
} from './workOrderCreation';

// ── Layer 1 urgent keyword list — PRD Section 6.7 ───────────────────────────

const LAYER1_KEYWORDS = [
  'emergency', 'fire', 'smoke',
  'gas smell', 'gas leak',
  'flood', 'flooding', 'water everywhere',
  'no power', 'power out',
  'locked out', "can't get in", 'cannot get in',
];

/** Case-insensitive scan of raw message text. Returns true if any Layer 1 keyword matches. */
export function hasUrgentKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return LAYER1_KEYWORDS.some(kw => lower.includes(kw));
}

// ── System prompt builder — PRD Section 6.2 ─────────────────────────────────

const EASTERN = 'America/New_York';

/**
 * Builds the system prompt for the AI inquiry response call.
 *
 * RULE C: Every value in this prompt comes from the database objects passed as
 * arguments. Nothing is hardcoded. Tests verify this by swapping the DB objects
 * and confirming the output changes accordingly.
 */
export function buildSystemPrompt(
  account: Pick<accounts, 'business_name' | 'communication_tone'>,
  property: Pick<
    properties,
    | 'name' | 'address' | 'checkin_time' | 'checkout_time'
    | 'door_access_instructions' | 'parking_instructions'
    | 'wifi_name' | 'wifi_password' | 'house_rules'
    | 'amenities' | 'local_recommendations' | 'special_instructions'
  >,
  booking: Pick<bookings, 'guest_first_name' | 'checkin_datetime' | 'checkout_datetime'>,
): string {
  const checkinET  = formatInTimeZone(booking.checkin_datetime,  EASTERN, 'MMM d, yyyy h:mm a zzz');
  const checkoutET = formatInTimeZone(booking.checkout_datetime, EASTERN, 'MMM d, yyyy h:mm a zzz');

  return [
    `You are the guest communication assistant for ${account.business_name}.`,
    `You respond on behalf of the property manager.`,
    `Your tone is ${account.communication_tone}.`,
    ``,
    `Property information:`,
    `- Name: ${property.name}`,
    `- Address: ${property.address}`,
    `- Check-in time: ${property.checkin_time}`,
    `- Check-out time: ${property.checkout_time}`,
    `- Door access: ${property.door_access_instructions ?? 'N/A'}`,
    `- Parking: ${property.parking_instructions ?? 'N/A'}`,
    `- Wi-Fi name: ${property.wifi_name ?? 'N/A'}`,
    `- Wi-Fi password: ${property.wifi_password ?? 'N/A'}`,
    `- House rules: ${property.house_rules ?? 'N/A'}`,
    `- Amenities: ${property.amenities ?? 'N/A'}`,
    `- Local recommendations: ${property.local_recommendations ?? 'N/A'}`,
    `- Special instructions: ${property.special_instructions ?? 'N/A'}`,
    ``,
    `Current guest: ${booking.guest_first_name}`,
    `Their check-in: ${checkinET}`,
    `Their check-out: ${checkoutET}`,
    ``,
    `Absolute rules:`,
    `1. Never invent information not listed above.`,
    `2. Always address the guest by first name.`,
    `3. If the answer is not in the property info: respond only with ESCALATE`,
    `4. Never share another guest's information.`,
    `5. Never promise refunds, exceptions, or policy changes.`,
    `6. If message contains: emergency, fire, smoke, gas, flood, no power, locked out`,
    `   --- respond only with: URGENT_ESCALATE`,
    `7. If guest reports a broken/malfunctioning item:`,
    `   respond only with: MAINTENANCE:[one sentence description]`,
  ].join('\n');
}

// ── Message payload shape (from webhook job data) ───────────────────────────

export interface MessagePayload {
  platform_message_id:    string;
  listing_id:             string;
  guest_platform_user_id: string;
  content:                string;
}

// ── AI call result ──────────────────────────────────────────────────────────

export interface AiCallResult {
  text:         string;
  inputTokens:  number;
  outputTokens: number;
}

// ── Injectable hooks for testing ────────────────────────────────────────────

export const _hooks = {
  aiCall: undefined as
    | ((systemPrompt: string, userMessage: string) => Promise<AiCallResult>)
    | undefined,
  platformSend: undefined as
    | ((platform: string, guestId: string, text: string) => Promise<void>)
    | undefined,
  smsSend: undefined as
    | ((to: string, from: string, body: string) => Promise<void>)
    | undefined,
  createWorkOrderFn: undefined as typeof createWorkOrderFromAI | undefined,
  retryDelayMs: 60_000,
};

// ── Default AI implementation ────────────────────────────────────────────────

async function defaultAiCall(systemPrompt: string, userMessage: string): Promise<AiCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userMessage }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected AI response type');

  return {
    text:         block.text.trim(),
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ── Outbound message helper ──────────────────────────────────────────────────

async function insertOutboundRow(
  accountId:  string,
  propertyId: string,
  bookingId:  string,
  platform:   'airbnb' | 'vrbo',
  content:    string,
): Promise<void> {
  await prisma.messages.create({
    data: {
      account_id:          accountId,
      property_id:         propertyId,
      booking_id:          bookingId,
      platform_message_id: `ai-${crypto.randomUUID()}`,
      direction:           'outbound',
      channel:             platform,
      sender:              'agent',
      content,
      status:              'auto_handled',
      sent_at:             new Date(),
    },
  });
}

// ── Urgent escalation message builders — PRD Section 6.4 ────────────────────

function buildUrgentGuestMessage(): string {
  return "We've received your message and our team is being contacted right now. We'll be with you as quickly as possible.";
}

function buildUrgentManagerAlert(
  guestFirstName: string,
  guestLastName:  string,
  propertyName:   string,
  messageContent: string,
): string {
  return (
    `URGENT: Guest ${guestFirstName} ${guestLastName} at ${propertyName}: ` +
    `'${messageContent}'. Please contact guest immediately.`
  );
}

// ── Core processing logic ────────────────────────────────────────────────────

async function processMessage(
  platform: 'airbnb' | 'vrbo',
  payload:  MessagePayload,
): Promise<void> {
  const { platform_message_id, listing_id, guest_platform_user_id, content } = payload;

  // ── RULE A, step 1 of 2: Quick read-side dedup check (optimisation only) ──
  // The real atomic guard is the INSERT below. This avoids expensive lookups for
  // obvious duplicates (e.g. webhook fires twice before any lookup completes).
  const existing = await prisma.messages.findUnique({
    where:  { platform_message_id },
    select: { id: true },
  });
  if (existing) {
    logger.info({ platform_message_id }, 'duplicate message — discarding');
    return;
  }

  // ── Lookup property ──────────────────────────────────────────────────────
  const listingField = platform === 'airbnb' ? 'airbnb_listing_id' : 'vrbo_listing_id';
  const property = await prisma.properties.findFirst({
    where: { [listingField]: listing_id },
  }) as properties | null;

  if (!property) {
    logger.warn({ platform, listing_id }, 'no property for listing_id — discarding message');
    return;
  }

  // ── Lookup full account ──────────────────────────────────────────────────
  const account = await prisma.accounts.findUnique({
    where: { id: property.account_id },
  }) as accounts | null;

  if (!account) {
    logger.warn({ accountId: property.account_id }, 'account not found — discarding message');
    return;
  }

  // ── Lookup active booking ────────────────────────────────────────────────
  const booking = await prisma.bookings.findFirst({
    where: {
      property_id:         property.id,
      guest_platform_id:   guest_platform_user_id,
      status:              'active',
    },
  }) as bookings | null;

  if (!booking) {
    logger.warn({ propertyId: property.id, guest_platform_user_id }, 'no active booking — alerting manager');
    const alertText =
      `QUESTION ESCALATED: Received message for property ${property.name} ` +
      `but no active booking found for guest. Message: '${content}'.`;
    await sendManagerSms(account, alertText, _hooks.smsSend ?? undefined);
    return;
  }

  // ── RULE A, step 2 of 2: Deduplication INSERT (atomic guard before AI work) ─
  let msgRow: { id: string };
  try {
    msgRow = await prisma.messages.create({
      data: {
        account_id:          account.id,
        property_id:         property.id,
        booking_id:          booking.id,
        platform_message_id,
        direction:           'inbound',
        channel:             platform,
        sender:              'guest',
        content,
        status:              'processing',
        sent_at:             new Date(),
      },
      select: { id: true },
    });
  } catch (err: unknown) {
    const isUniqueViolation = err instanceof Error && (err as { code?: string }).code === 'P2002';
    if (isUniqueViolation) {
      logger.info({ platform_message_id }, 'concurrent duplicate — discarding');
      return;
    }
    throw err;
  }

  const msgId = msgRow.id;

  // Helper: finalize the inbound message row.
  async function finaliseInbound(
    status:               'auto_handled' | 'escalated' | 'failed',
    intentClassification: string,
    isUrgent:             boolean,
    escalationReason?:    string,
  ): Promise<void> {
    await prisma.messages.update({
      where: { id: msgId },
      data: {
        status,
        intent_classification: intentClassification,
        is_urgent:             isUrgent,
        ...(escalationReason ? { escalation_reason: escalationReason } : {}),
      },
    });
  }

  // ESCALATE path (standard).
  async function doEscalate(reason: string): Promise<void> {
    const holdingMsg = buildEscalateHoldingMessage(booking!.guest_first_name);
    await sendPlatformMessage(account!, booking!, holdingMsg, _hooks.platformSend ?? undefined);
    await insertOutboundRow(account!.id, property!.id, booking!.id, platform, holdingMsg);

    const managerAlert = buildEscalateManagerAlert(
      booking!.guest_first_name,
      booking!.guest_last_name,
      property!.name,
      content,
      account!.business_name,
    );
    await sendManagerSms(account!, managerAlert, _hooks.smsSend ?? undefined);
    await finaliseInbound('escalated', 'escalated', false, reason);
  }

  // URGENT_ESCALATE path.
  async function doUrgentEscalate(reason: string): Promise<void> {
    const urgentMsg = buildUrgentGuestMessage();
    await sendPlatformMessage(account!, booking!, urgentMsg, _hooks.platformSend ?? undefined);
    await insertOutboundRow(account!.id, property!.id, booking!.id, platform, urgentMsg);

    const managerAlert = buildUrgentManagerAlert(
      booking!.guest_first_name,
      booking!.guest_last_name,
      property!.name,
      content,
    );
    // URGENT: always SMS regardless of alert_channel (PRD Section 6.4).
    await sendManagerSms(account!, managerAlert, _hooks.smsSend ?? undefined);
    await finaliseInbound('escalated', 'urgent_escalated', true, reason);
  }

  // ── TOKEN CAP CHECK (no AI call if over cap) ──────────────────────────────
  if (account.daily_ai_token_usage >= account.ai_token_daily_cap) {
    logger.warn({ accountId: account.id }, 'AI token cap reached — escalating without AI call');
    await doEscalate('token_cap_reached');
    return;
  }

  // ── RULE B: LAYER 1 URGENT KEYWORD SCAN (before any AI call) ─────────────
  if (hasUrgentKeyword(content)) {
    logger.info({ msgId }, 'Layer 1 urgent keyword match — URGENT_ESCALATE without AI call');
    await doUrgentEscalate('layer1_keyword_match');
    return;
  }

  // ── RULE C: BUILD SYSTEM PROMPT (from DB values only) ────────────────────
  const systemPrompt = buildSystemPrompt(account, property, booking);

  // ── AI CALL (10s timeout) ─────────────────────────────────────────────────
  let aiResult: AiCallResult;
  const aiCallFn = _hooks.aiCall ?? defaultAiCall;

  try {
    aiResult = await Promise.race([
      aiCallFn(systemPrompt, content),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI call timeout after 10s')), 10_000),
      ),
    ]);
  } catch (err) {
    logger.warn({ err, msgId }, 'AI call failed or timed out — escalating');
    await doEscalate('ai_call_failed');
    return;
  }

  // ── INCREMENT TOKEN USAGE ─────────────────────────────────────────────────
  const tokensUsed = aiResult.inputTokens + aiResult.outputTokens;
  if (tokensUsed > 0) {
    await prisma.accounts.update({
      where: { id: account.id },
      data:  { daily_ai_token_usage: { increment: tokensUsed } },
    });
  }

  // ── EVALUATE AI RESPONSE ──────────────────────────────────────────────────
  const aiText = aiResult.text;

  if (aiText === 'ESCALATE') {
    await doEscalate('ai_escalate');
    return;
  }

  if (aiText === 'URGENT_ESCALATE') {
    await doUrgentEscalate('ai_urgent_escalate');
    return;
  }

  if (aiText.startsWith('MAINTENANCE:')) {
    const description = aiText.slice('MAINTENANCE:'.length).trim();
    const workOrderFn = _hooks.createWorkOrderFn ?? createWorkOrderFromAI;
    const deps: CreateWorkOrderDeps = {
      sendPlatformMessageFn: _hooks.platformSend ?? undefined,
      sendSmsFn:             _hooks.smsSend ?? undefined,
    };
    // createWorkOrderFromAI handles Steps 1-7 of PRD Section 8.2, including
    // sending the guest acknowledgment and setting maintenance_triggered = true.
    const woResult = await workOrderFn(
      { account, property, booking, sourceMessage: { id: msgId, content } as any, maintenanceDescription: description },
      deps,
    );
    logger.info({ msgId, woResult }, 'MAINTENANCE path complete');

    // If createWorkOrderFromAI escalated internally (empty description), it already
    // set status='escalated' on the row. Otherwise mark auto_handled.
    if (woResult.outcome !== 'escalated') {
      await prisma.messages.update({
        where: { id: msgId },
        data:  { intent_classification: 'maintenance', status: 'auto_handled' },
      });
    }
    return;
  }

  // ── NORMAL RESPONSE ───────────────────────────────────────────────────────
  await sendPlatformMessage(account, booking, aiText, _hooks.platformSend ?? undefined);
  await insertOutboundRow(account.id, property.id, booking.id, platform, aiText);
  await finaliseInbound('auto_handled', 'auto_handled', false);
}

// ── pg-boss handler wrappers ─────────────────────────────────────────────────

export async function processAirbnbMessageHandler(job: { data: unknown }): Promise<void> {
  await processMessage('airbnb', job.data as MessagePayload);
}

export async function processVrboMessageHandler(job: { data: unknown }): Promise<void> {
  await processMessage('vrbo', job.data as MessagePayload);
}
