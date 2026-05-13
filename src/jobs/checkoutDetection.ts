/**
 * T-039 — Feature 2.1 — Auto-Schedule Cleaner
 *
 * Detects guest checkout via two paths:
 *   Trigger A (webhooks): process-airbnb-checkout / process-vrbo-checkout
 *   Trigger B (hourly):   checkout-detection-sweep
 *
 * Both paths converge on dispatchCleaner(bookingId).
 *
 * CRITICAL: The bookings status transition (active → completed) is performed
 * via raw SQL so that the WHERE status = 'active' check is atomic. This
 * prevents double-dispatch if Trigger A and Trigger B fire concurrently.
 * Do NOT replace this with a Prisma ORM update call.
 */

import twilio from 'twilio';
import { formatInTimeZone } from 'date-fns-tz';
import type { accounts, bookings, cleaners, properties } from '@prisma/client';

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendManagerSms } from './workOrderCreation';

const EASTERN = 'America/New_York';

// ── Injectable hooks for testing ─────────────────────────────────────────────

export const _hooks = {
  smsSend: undefined as
    | ((to: string, from: string, body: string) => Promise<void>)
    | undefined,
  retryDelayMs: undefined as number | undefined,
};

// ── Sleep helper ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── SMS template — PRD Section 7.2 ───────────────────────────────────────────

export function buildCleanerSmsText({
  cleanerName,
  propertyName,
  propertyAddress,
  checkoutTimeEastern,
  nextCheckinLine,
  businessName,
}: {
  cleanerName:         string;
  propertyName:        string;
  propertyAddress:     string;
  checkoutTimeEastern: string;
  nextCheckinLine:     string;
  businessName:        string;
}): string {
  const parts: string[] = [
    `Hi ${cleanerName}, turnover job at ${propertyName}.`,
    `Address: ${propertyAddress}`,
    `Guest checkout: ${checkoutTimeEastern}`,
  ];
  if (nextCheckinLine) parts.push(nextCheckinLine);
  parts.push('Reply CONFIRM to accept.');
  parts.push(`- ${businessName}`);
  return parts.join('\n');
}

// ── Cleaner SMS with Rule 3 retry ─────────────────────────────────────────────

async function sendCleanerSmsWithRetry(
  account: accounts,
  cleanerPhone: string,
  body: string,
): Promise<void> {
  if (!account.twilio_phone_number) {
    logger.warn({ accountId: account.id }, 'checkout-detection: Twilio phone not configured');
    return;
  }

  const send    = _hooks.smsSend ?? defaultSendSms;
  const delayMs = _hooks.retryDelayMs ?? 60_000;

  try {
    await send(cleanerPhone, account.twilio_phone_number, body);
  } catch (firstErr) {
    logger.warn({ err: firstErr }, 'checkout-detection: cleaner SMS failed — retrying (Rule 3)');
    await sleep(delayMs);
    // Second attempt — throws on failure; caller handles permanent failure
    await send(cleanerPhone, account.twilio_phone_number, body);
  }
}

async function defaultSendSms(to: string, from: string, body: string): Promise<void> {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    logger.warn('checkout-detection: Twilio credentials not set');
    return;
  }

  const client = twilio(sid, token);
  await client.messages.create({ body, from, to });
}

// ── Types ────────────────────────────────────────────────────────────────────

type BookingWithRelations = bookings & {
  property: properties;
  account:  accounts;
};

// ── Core dispatch function ────────────────────────────────────────────────────

/**
 * Shared by both Trigger A (webhook) and Trigger B (sweep).
 *
 * Step 1 uses raw SQL so the 'active' guard and the status write are atomic —
 * no two concurrent calls can both proceed past this point for the same booking.
 */
export async function dispatchCleaner(bookingId: string): Promise<void> {

  // ── Step 1: Atomic raw-SQL conditional UPDATE ────────────────────────────
  // CRITICAL: Do NOT replace with Prisma ORM. The raw WHERE status = 'active'
  // check must execute atomically with the SET to prevent double-dispatch.
  const affected = await prisma.$executeRaw`
    UPDATE bookings SET status = 'completed' WHERE id = ${bookingId} AND status = 'active'
  `;

  if (Number(affected) === 0) {
    logger.info({ bookingId }, 'checkout-detection: booking not active — discarding (already processed)');
    return;
  }

  // ── Step 2: Load relations and mark property ─────────────────────────────
  const booking = await prisma.bookings.findUnique({
    where:   { id: bookingId },
    include: { property: true, account: true },
  }) as BookingWithRelations | null;

  if (!booking) {
    logger.error({ bookingId }, 'checkout-detection: booking not found after atomic update');
    return;
  }

  const { property, account } = booking;

  await prisma.properties.update({
    where: { id: property.id },
    data:  { property_status: 'needs_cleaning' },
  });

  // ── Step 3: Check auto-schedule flag ────────────────────────────────────
  if (!property.auto_schedule_cleaner_enabled) {
    logger.info(
      { bookingId, propertyId: property.id },
      'checkout-detection: auto-schedule disabled — skipping cleaner dispatch',
    );
    return;
  }

  // ── Step 4: Find primary active cleaner ──────────────────────────────────
  const primaryAssignment = await prisma.property_cleaners.findFirst({
    where: {
      property_id: property.id,
      is_primary:  true,
      cleaner:     { is_active: true },
    },
    include: { cleaner: true },
  });

  if (!primaryAssignment) {
    logger.warn({ propertyId: property.id }, 'checkout-detection: no active primary cleaner');

    const alertText =
      `NO CLEANER: No active primary cleaner assigned to ${property.name}. ` +
      `Guest has checked out. Please assign a cleaner manually. ` +
      `- ${account.business_name}`;

    await sendManagerSms(account, alertText).catch((err: unknown) =>
      logger.error({ err }, 'checkout-detection: manager alert send failed'),
    );
    return;
  }

  const cleaner = primaryAssignment.cleaner as cleaners;

  // ── Step 5: Find next upcoming booking for deadline ──────────────────────
  const now = new Date();
  const nextBooking = await prisma.bookings.findFirst({
    where: {
      property_id:      property.id,
      status:           'upcoming',
      checkin_datetime: { gt: now },
    },
    orderBy: { checkin_datetime: 'asc' },
    select:  { id: true, checkin_datetime: true },
  });

  const deadline = nextBooking?.checkin_datetime ?? null;

  // ── Step 6: INSERT cleaning_jobs — discard silently on UNIQUE violation ──
  let jobId: string | null = null;

  try {
    const job = await prisma.cleaning_jobs.create({
      data: {
        account_id:      account.id,
        property_id:     property.id,
        booking_id:      booking.id,
        next_booking_id: nextBooking?.id ?? null,
        cleaner_id:      cleaner.id,
        status:          'scheduled',
        scheduled_start: booking.checkout_datetime,
        deadline,
      },
      select: { id: true },
    });
    jobId = job.id;
    logger.info({ jobId, bookingId }, 'checkout-detection: cleaning job created');
  } catch (err: unknown) {
    const isPrismaP2002 =
      err instanceof Error && (err as { code?: string }).code === 'P2002';
    if (!isPrismaP2002) throw err;
    logger.warn({ bookingId }, 'checkout-detection: cleaning job already exists — discarding silently');
    return;
  }

  // ── Step 7: Build and send cleaner SMS ───────────────────────────────────
  const checkoutTimeEastern = formatInTimeZone(
    booking.checkout_datetime,
    EASTERN,
    'MMM d, yyyy h:mm a zzz',
  );

  const nextCheckinLine = nextBooking
    ? `Next check-in: ${formatInTimeZone(nextBooking.checkin_datetime, EASTERN, 'MMM d, yyyy h:mm a zzz')}`
    : '';

  const smsText = buildCleanerSmsText({
    cleanerName:         cleaner.name,
    propertyName:        property.name,
    propertyAddress:     property.address,
    checkoutTimeEastern,
    nextCheckinLine,
    businessName:        account.business_name,
  });

  try {
    await sendCleanerSmsWithRetry(account, cleaner.phone, smsText);
  } catch (err) {
    logger.error({ err, jobId, bookingId }, 'checkout-detection: cleaner SMS permanently failed');
    const failureAlert =
      `SEND FAILURE: Could not notify cleaner ${cleaner.name} about turnover at ${property.name}. ` +
      `Please contact the cleaner directly. - ${account.business_name}`;
    await sendManagerSms(account, failureAlert).catch((smsErr: unknown) =>
      logger.error({ err: smsErr }, 'checkout-detection: failure alert also failed'),
    );
    return;
  }

  // ── Step 8: Flag job as notified ─────────────────────────────────────────
  await prisma.cleaning_jobs.update({
    where: { id: jobId! },
    data: {
      job_notification_sent:    true,
      job_notification_sent_at: new Date(),
    },
  });

  logger.info({ jobId, cleanerId: cleaner.id }, 'checkout-detection: cleaner notified');
}

// ── Trigger B: checkout-detection-sweep ──────────────────────────────────────

export async function checkoutDetectionSweepHandler(): Promise<void> {
  const now            = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const candidates = await prisma.bookings.findMany({
    where: {
      status:           'active',
      checkout_datetime: { lte: now, gte: twentyFourHoursAgo },
      cleaning_job:     { is: null },
    },
    select: { id: true },
  });

  if (candidates.length === 0) {
    logger.info('checkout-detection-sweep: no candidates');
    return;
  }

  logger.info({ count: candidates.length }, 'checkout-detection-sweep: candidates found');

  for (const { id: bookingId } of candidates) {
    try {
      await dispatchCleaner(bookingId);
    } catch (err) {
      logger.error({ err, bookingId }, 'checkout-detection-sweep: dispatch failed');
    }
  }
}

// ── Trigger A: webhook handlers ───────────────────────────────────────────────

type CheckoutPayload = {
  platform_booking_id?: string;
  listing_id?:          string;
};

async function handleCheckoutWebhook(
  data:     CheckoutPayload,
  platform: 'airbnb' | 'vrbo',
): Promise<void> {
  const { platform_booking_id, listing_id } = data;

  if (!platform_booking_id || !listing_id) {
    logger.warn({ data, platform }, 'checkout-detection: missing platform_booking_id or listing_id');
    return;
  }

  const listingField = platform === 'airbnb' ? 'airbnb_listing_id' : 'vrbo_listing_id';

  const property = await prisma.properties.findFirst({
    where: { [listingField]: listing_id },
    select: { id: true },
  });

  if (!property) {
    logger.warn({ listing_id, platform }, 'checkout-detection: property not found');
    return;
  }

  const booking = await prisma.bookings.findFirst({
    where: {
      property_id:          property.id,
      platform,
      platform_booking_id,
      status:               'active',
    },
    select: { id: true },
  });

  if (!booking) {
    logger.warn({ platform_booking_id, listing_id }, 'checkout-detection: no active booking found');
    return;
  }

  await dispatchCleaner(booking.id);
}

export async function processAirbnbCheckoutHandler(job: { data: unknown }): Promise<void> {
  await handleCheckoutWebhook(job.data as CheckoutPayload, 'airbnb');
}

export async function processVrboCheckoutHandler(job: { data: unknown }): Promise<void> {
  await handleCheckoutWebhook(job.data as CheckoutPayload, 'vrbo');
}
