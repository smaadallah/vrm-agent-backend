/**
 * T-029 — Feature 1.3 — checkout-reminder-sweep Job
 *
 * Hourly sweep:
 *   - 19:30–21:00 ET  → send checkout reminders to active guests with
 *                        tomorrow's checkout date.
 *   - 21:00–22:00 ET  → missed-send check: alert manager for any bookings
 *                        that still have checkout_reminder_sent = false.
 *   - All other times  → skip entirely (AC2).
 */

import type { accounts, bookings, properties } from '@prisma/client';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendPlatformMessage, sendManagerSms } from './workOrderCreation';

const EASTERN = 'America/New_York';

// Window boundaries in minutes-since-midnight ET.
const SEND_WINDOW_START_MIN = 19 * 60 + 30;  // 19:30 → 1170
const SEND_WINDOW_END_MIN   = 21 * 60;        // 21:00 → 1260
const MISSED_CHECK_END_MIN  = 22 * 60;        // 22:00 → 1320

// ── Default template — PRD Section 6.6 ──────────────────────────────────────

const DEFAULT_TEMPLATE = [
  'Hi {{guest_first_name}}! Just a friendly reminder that check-out is tomorrow at {{checkout_time}}.',
  'When you\'re ready to head out:',
  '{{checkout_steps}}',
  'Thank you so much for staying with us. If there\'s anything you need before you leave, just reply here.',
  'Safe travels!',
  '{{business_name}}',
].join('\n');

// ── Injectable hooks for testing ─────────────────────────────────────────────

export const _hooks = {
  now: undefined as (() => Date) | undefined,
  platformSend: undefined as
    | ((platform: string, guestId: string, text: string) => Promise<void>)
    | undefined,
  smsSend: undefined as
    | ((to: string, from: string, body: string) => Promise<void>)
    | undefined,
};

function getNow(): Date {
  return _hooks.now ? _hooks.now() : new Date();
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/** Returns minutes-since-midnight for the given UTC instant in Eastern Time. */
export function getEasternMinutes(now: Date): number {
  const et = toZonedTime(now, EASTERN);
  return et.getHours() * 60 + et.getMinutes();
}

/**
 * Returns the UTC time range that corresponds to "tomorrow's date" in ET.
 * e.g. if now is 2026-07-14 20:00 ET, tomorrow ET is 2026-07-15,
 * which spans 2026-07-15 04:00 UTC → 2026-07-16 04:00 UTC (EDT, UTC-4).
 */
export function getTomorrowUTCBounds(now: Date): { start: Date; end: Date } {
  const nowET = toZonedTime(now, EASTERN);
  const y = nowET.getFullYear();
  const m = nowET.getMonth();
  const d = nowET.getDate();

  const start = fromZonedTime(new Date(y, m, d + 1, 0, 0, 0, 0), EASTERN);
  const end   = fromZonedTime(new Date(y, m, d + 2, 0, 0, 0, 0), EASTERN);
  return { start, end };
}

// ── Template builder ─────────────────────────────────────────────────────────

interface TemplateVars {
  guestFirstName: string;
  checkoutTime:   string;
  checkoutSteps:  string;
  businessName:   string;
}

/**
 * Substitutes {{token}} placeholders with database values.
 * Uses property's custom template when set; falls back to the PRD default.
 * All values come from the caller — nothing is hardcoded.
 */
export function buildCheckoutReminderMessage(
  customTemplate: string | null,
  vars: TemplateVars,
): string {
  const template = customTemplate ?? DEFAULT_TEMPLATE;
  return template
    .replace(/\{\{guest_first_name\}\}/g, vars.guestFirstName)
    .replace(/\{\{checkout_time\}\}/g,    vars.checkoutTime)
    .replace(/\{\{checkout_steps\}\}/g,   vars.checkoutSteps)
    .replace(/\{\{business_name\}\}/g,    vars.businessName);
}

// ── Types ────────────────────────────────────────────────────────────────────

type BookingWithRelations = bookings & {
  property: properties;
  account:  accounts;
};

// ── Send and update helper ────────────────────────────────────────────────────

async function sendAndUpdate(booking: BookingWithRelations): Promise<void> {
  const { property, account } = booking;

  const vars: TemplateVars = {
    guestFirstName: booking.guest_first_name,
    checkoutTime:   property.checkout_time,
    checkoutSteps:  property.checkout_steps ?? '',
    businessName:   account.business_name,
  };

  const messageText = buildCheckoutReminderMessage(
    property.checkout_reminder_template,
    vars,
  );

  await sendPlatformMessage(account, booking, messageText, _hooks.platformSend ?? undefined);

  await prisma.bookings.update({
    where: { id: booking.id },
    data: {
      checkout_reminder_sent:    true,
      checkout_reminder_sent_at: new Date(),
    },
  });

  logger.info(
    { bookingId: booking.id, propertyId: property.id },
    'checkout-reminder-sweep: reminder sent',
  );
}

// ── Sweep handler ─────────────────────────────────────────────────────────────

export async function checkoutReminderSweepHandler(): Promise<void> {
  const now    = getNow();
  const etMins = getEasternMinutes(now);

  // ── Skip entirely when outside the relevant time range ──────────────────
  if (etMins < SEND_WINDOW_START_MIN || etMins >= MISSED_CHECK_END_MIN) {
    logger.info({ etMins }, 'checkout-reminder-sweep: outside time range — skipping');
    return;
  }

  const { start: tomorrowStart, end: tomorrowEnd } = getTomorrowUTCBounds(now);

  // ── Fetch unsent reminders for tomorrow's checkouts ──────────────────────
  const candidates = await prisma.bookings.findMany({
    where: {
      status:                 'active',
      checkout_reminder_sent: false,
      checkout_datetime: {
        gte: tomorrowStart,
        lt:  tomorrowEnd,
      },
    },
    include: { property: true, account: true },
  }) as BookingWithRelations[];

  // ── 21:00–22:00 ET: missed-send check ────────────────────────────────────
  if (etMins >= SEND_WINDOW_END_MIN) {
    if (candidates.length === 0) {
      logger.info('checkout-reminder-sweep: 21:00 check — no missed reminders');
      return;
    }

    logger.warn(
      { count: candidates.length },
      'checkout-reminder-sweep: 21:00 — reminders not sent, alerting managers',
    );

    for (const booking of candidates) {
      const alertText =
        `CHECKOUT REMINDER MISSED: Guest ${booking.guest_first_name} ${booking.guest_last_name} ` +
        `at ${booking.property.name} checks out tomorrow and did not receive a reminder. ` +
        `Please contact the guest manually. - ${booking.account.business_name}`;

      try {
        await sendManagerSms(booking.account, alertText, _hooks.smsSend ?? undefined);
      } catch (err) {
        logger.error({ err, bookingId: booking.id }, 'checkout-reminder-sweep: manager alert failed');
      }
    }
    return;
  }

  // ── 19:30–21:00 ET: send window ───────────────────────────────────────────
  if (candidates.length === 0) {
    logger.info('checkout-reminder-sweep: no candidates in window');
    return;
  }

  logger.info({ count: candidates.length }, 'checkout-reminder-sweep: candidates found');

  for (const booking of candidates) {
    // AC4: skip if checkout reminders disabled for this property.
    if (!booking.property.checkout_reminder_enabled) {
      logger.info({ bookingId: booking.id }, 'checkout-reminder-sweep: reminders disabled — skipping');
      continue;
    }

    try {
      await sendAndUpdate(booking);
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, 'checkout-reminder-sweep: send failed');
    }
  }
}
