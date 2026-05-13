/**
 * T-030 — Feature 1.5 — review-request-sweep Job
 *
 * Hourly sweep: sends post-stay review requests to guests whose
 * checkout_datetime falls within the per-property configurable window
 * (default: NOW - review_request_hours_after ± 0.5h).
 *
 * No URL is included — Airbnb's API does not support third-party URLs
 * (PRD Section 6.8, permanent approach for MVP).
 */

import type { accounts, bookings, properties } from '@prisma/client';

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendPlatformMessage } from './workOrderCreation';

// ── Default template — PRD Section 6.8 ──────────────────────────────────────

const DEFAULT_TEMPLATE = [
  'Hi {{guest_first_name}}! We hope you had a wonderful stay at {{property_name}}.',
  'It was truly a pleasure hosting you.',
  'If you have a moment, you can leave us a review directly in your {{platform}} app under your past trips — it means the world to us.',
  'Thank you again, and we hope to welcome you back someday!',
  'Warm regards,',
  '{{business_name}}',
].join('\n');

// ── Injectable hooks for testing ─────────────────────────────────────────────

export const _hooks = {
  now: undefined as (() => Date) | undefined,
  platformSend: undefined as
    | ((platform: string, guestId: string, text: string) => Promise<void>)
    | undefined,
};

function getNow(): Date {
  return _hooks.now ? _hooks.now() : new Date();
}

// ── Template builder ─────────────────────────────────────────────────────────

interface TemplateVars {
  guestFirstName: string;
  propertyName:   string;
  platform:       string;
  businessName:   string;
}

/**
 * Substitutes {{token}} placeholders with database values.
 * Uses property's custom template when set; falls back to the PRD default.
 * All values come from the caller — nothing is hardcoded.
 */
export function buildReviewRequestMessage(
  customTemplate: string | null,
  vars: TemplateVars,
): string {
  const template = customTemplate ?? DEFAULT_TEMPLATE;
  return template
    .replace(/\{\{guest_first_name\}\}/g, vars.guestFirstName)
    .replace(/\{\{property_name\}\}/g,    vars.propertyName)
    .replace(/\{\{platform\}\}/g,         vars.platform)
    .replace(/\{\{business_name\}\}/g,    vars.businessName);
}

/** Maps booking.platform enum to display name. */
export function platformDisplayName(platform: string): string {
  if (platform === 'vrbo') return 'VRBO';
  return platform.charAt(0).toUpperCase() + platform.slice(1);
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
    propertyName:   property.name,
    platform:       platformDisplayName(booking.platform),
    businessName:   account.business_name,
  };

  const messageText = buildReviewRequestMessage(
    property.review_request_template,
    vars,
  );

  await sendPlatformMessage(account, booking, messageText, _hooks.platformSend ?? undefined);

  await prisma.bookings.update({
    where: { id: booking.id },
    data: {
      review_request_sent:    true,
      review_request_sent_at: new Date(),
    },
  });

  logger.info(
    { bookingId: booking.id, propertyId: property.id },
    'review-request-sweep: review request sent',
  );
}

// ── Sweep handler ─────────────────────────────────────────────────────────────

/**
 * Hourly sweep: finds all recently completed bookings whose checkout_datetime
 * sits in the per-property ±0.5h window around NOW - review_request_hours_after,
 * then sends and flags each one.
 *
 * The query uses a broad 0–72h look-back window and filters per-booking in
 * application code because review_request_hours_after varies per property.
 * Duration arithmetic is timezone-agnostic per PRD Rule 2 (Section 4).
 */
export async function reviewRequestSweepHandler(): Promise<void> {
  const now        = getNow();
  const lowerBound = new Date(now.getTime() - 72 * 60 * 60 * 1000);

  const candidates = await prisma.bookings.findMany({
    where: {
      status:              'completed',
      review_request_sent: false,
      checkout_datetime:   { gte: lowerBound, lt: now },
    },
    include: {
      property: true,
      account:  true,
    },
  }) as BookingWithRelations[];

  if (candidates.length === 0) {
    logger.info('review-request-sweep: no candidates');
    return;
  }

  logger.info({ count: candidates.length }, 'review-request-sweep: candidates found');

  for (const booking of candidates) {
    const { property } = booking;

    // AC3: skip if review requests disabled for this property.
    if (!property.review_request_enabled) {
      logger.info({ bookingId: booking.id }, 'review-request-sweep: requests disabled — skipping');
      continue;
    }

    // Per-property window check: checkout_datetime must fall within
    // [now - (hours_after + 0.5h), now - (hours_after - 0.5h)].
    const hoursAfter  = property.review_request_hours_after;
    const windowStart = new Date(now.getTime() - (hoursAfter + 0.5) * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() - (hoursAfter - 0.5) * 60 * 60 * 1000);

    if (booking.checkout_datetime < windowStart || booking.checkout_datetime > windowEnd) {
      logger.info(
        { bookingId: booking.id, checkoutDatetime: booking.checkout_datetime },
        'review-request-sweep: outside window — skipping',
      );
      continue;
    }

    try {
      await sendAndUpdate(booking);
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, 'review-request-sweep: send failed');
    }
  }
}
