/**
 * T-028 — Feature 1.2 — checkin-message-sweep Job
 *
 * Hourly sweep: sends pre-arrival check-in messages to guests whose
 * checkin_datetime falls within the per-property configurable window.
 * Also exports sendImmediateCheckinMessage() for the last-minute booking
 * override (called by T-023 bookingSync when a booking is created within
 * checkin_message_hours_before + 1h of check-in).
 */

import type { accounts, bookings, properties } from '@prisma/client';

import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendPlatformMessage } from './workOrderCreation';

// ── Default template — PRD Section 6.5 ──────────────────────────────────────

const DEFAULT_TEMPLATE = [
  'Hi {{guest_first_name}}! We\'re so excited to welcome you to {{property_name}} tomorrow.',
  'Here are your arrival details:',
  'Check-in time: {{checkin_time}}',
  'Address: {{address}}',
  'Door access: {{door_access}}',
  'Parking: {{parking}}',
  'Wi-Fi: {{wifi_name}} / Password: {{wifi_password}}',
  'A few things to keep in mind: {{house_rules}}',
  'If you need anything before or during your stay, just reply to this message.',
  'See you soon!',
  '{{business_name}}',
].join('\n');

// ── Injectable hooks for testing ─────────────────────────────────────────────

export const _hooks = {
  platformSend: undefined as
    | ((platform: string, guestId: string, text: string) => Promise<void>)
    | undefined,
};

// ── Template builder ─────────────────────────────────────────────────────────

interface TemplateVars {
  guestFirstName: string;
  propertyName:   string;
  checkinTime:    string;
  address:        string;
  doorAccess:     string;
  parking:        string;
  wifiName:       string;
  wifiPassword:   string;
  houseRules:     string;
  businessName:   string;
}

/**
 * Builds the check-in message by substituting {{token}} placeholders with
 * database values. All values come from the caller — nothing is hardcoded.
 *
 * Uses the property's custom template when set; falls back to the PRD default.
 */
export function buildCheckinMessage(
  customTemplate: string | null,
  vars: TemplateVars,
): string {
  const template = customTemplate ?? DEFAULT_TEMPLATE;
  return template
    .replace(/\{\{guest_first_name\}\}/g, vars.guestFirstName)
    .replace(/\{\{property_name\}\}/g,    vars.propertyName)
    .replace(/\{\{checkin_time\}\}/g,     vars.checkinTime)
    .replace(/\{\{address\}\}/g,          vars.address)
    .replace(/\{\{door_access\}\}/g,      vars.doorAccess)
    .replace(/\{\{parking\}\}/g,          vars.parking)
    .replace(/\{\{wifi_name\}\}/g,        vars.wifiName)
    .replace(/\{\{wifi_password\}\}/g,    vars.wifiPassword)
    .replace(/\{\{house_rules\}\}/g,      vars.houseRules)
    .replace(/\{\{business_name\}\}/g,    vars.businessName);
}

// ── Shared send-and-update helper ────────────────────────────────────────────

type BookingWithRelations = bookings & {
  property: properties;
  account:  accounts;
};

async function sendAndUpdate(booking: BookingWithRelations): Promise<void> {
  const { property, account } = booking;

  const vars: TemplateVars = {
    guestFirstName: booking.guest_first_name,
    propertyName:   property.name,
    checkinTime:    property.checkin_time,
    address:        property.address,
    doorAccess:     property.door_access_instructions ?? '',
    parking:        property.parking_instructions     ?? '',
    wifiName:       property.wifi_name                ?? '',
    wifiPassword:   property.wifi_password            ?? '',
    houseRules:     property.house_rules              ?? '',
    businessName:   account.business_name,
  };

  const messageText = buildCheckinMessage(property.checkin_message_template, vars);

  await sendPlatformMessage(account, booking, messageText, _hooks.platformSend ?? undefined);

  await prisma.bookings.update({
    where: { id: booking.id },
    data: {
      checkin_message_sent:    true,
      checkin_message_sent_at: new Date(),
    },
  });

  logger.info(
    { bookingId: booking.id, propertyId: property.id, guestFirstName: booking.guest_first_name },
    'checkin-message-sweep: check-in message sent',
  );
}

// ── Sweep handler ─────────────────────────────────────────────────────────────

/**
 * Hourly sweep: finds all upcoming bookings whose checkin_datetime sits in the
 * per-property ±0.5h window around NOW + checkin_message_hours_before, then
 * sends and flags each one.
 *
 * The query uses a broad 0–72h look-ahead window and filters per-booking in
 * application code because checkin_message_hours_before varies per property.
 * Duration arithmetic is timezone-agnostic per PRD Rule (Section 4).
 */
export async function checkinMessageSweepHandler(): Promise<void> {
  const now        = new Date();
  const upperBound = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const candidates = await prisma.bookings.findMany({
    where: {
      status:               'upcoming',
      checkin_message_sent: false,
      checkin_datetime:     { gt: now, lte: upperBound },
    },
    include: {
      property: true,
      account:  true,
    },
  }) as BookingWithRelations[];

  if (candidates.length === 0) {
    logger.info('checkin-message-sweep: no candidates');
    return;
  }

  logger.info({ count: candidates.length }, 'checkin-message-sweep: candidates found');

  for (const booking of candidates) {
    const { property } = booking;

    // AC4: skip if check-in messaging disabled for this property.
    if (!property.checkin_message_enabled) {
      logger.info({ bookingId: booking.id }, 'checkin-message-sweep: messaging disabled — skipping');
      continue;
    }

    // Per-property window check: checkin_datetime must fall within
    // [now + (hours_before - 0.5h), now + (hours_before + 0.5h)].
    const hoursB      = property.checkin_message_hours_before;
    const windowStart = new Date(now.getTime() + (hoursB - 0.5) * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + (hoursB + 0.5) * 60 * 60 * 1000);

    if (booking.checkin_datetime < windowStart || booking.checkin_datetime > windowEnd) {
      logger.info(
        { bookingId: booking.id, checkinDatetime: booking.checkin_datetime },
        'checkin-message-sweep: outside window — skipping',
      );
      continue;
    }

    try {
      await sendAndUpdate(booking);
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, 'checkin-message-sweep: send failed');
    }
  }
}

// ── Last-minute override ──────────────────────────────────────────────────────

/**
 * Sends the check-in message immediately for a given booking, bypassing the
 * time-window check. Used for last-minute bookings created within
 * checkin_message_hours_before + 1h of check-in (PRD Section 6.5).
 */
export async function sendImmediateCheckinMessage(bookingId: string): Promise<void> {
  const booking = await prisma.bookings.findUnique({
    where:   { id: bookingId },
    include: { property: true, account: true },
  }) as BookingWithRelations | null;

  if (!booking) {
    logger.warn({ bookingId }, 'sendImmediateCheckinMessage: booking not found');
    return;
  }

  if (!booking.property.checkin_message_enabled) {
    logger.info({ bookingId }, 'sendImmediateCheckinMessage: messaging disabled — skipping');
    return;
  }

  if (booking.checkin_message_sent) {
    logger.info({ bookingId }, 'sendImmediateCheckinMessage: already sent — skipping');
    return;
  }

  await sendAndUpdate(booking);
}
