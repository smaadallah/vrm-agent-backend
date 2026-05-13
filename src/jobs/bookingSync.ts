/**
 * T-023 — Booking Sync Worker: Airbnb & VRBO Webhook Processing
 * T-024 — Booking Cancellation Handler
 */

import twilio from 'twilio';
import prisma from '../lib/prisma';
import logger from '../lib/logger';

export interface BookingPayload {
  platform_booking_id: string;
  listing_id: string;
  guest_platform_user_id: string;
  guest_first_name: string;
  guest_last_name: string;
  checkin_datetime: string;   // ISO string
  checkout_datetime: string;  // ISO string
  status: string;             // 'upcoming' | 'active' | 'cancelled' etc.
}

// Injectable overrides for testing.
export const _hooks = {
  handleCancellation: undefined as
    | ((bookingId: string, accountId: string) => Promise<void>)
    | undefined,
  sendSms: undefined as
    | ((to: string, from: string, body: string) => Promise<void>)
    | undefined,
  retryDelayMs: 60_000,
};

// ── SMS helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function defaultSendSms(to: string, from: string, body: string): Promise<void> {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    logger.warn('Twilio credentials not set — skipping SMS send');
    return;
  }
  const client = twilio(sid, token);
  await client.messages.create({ body, from, to });
}

/**
 * Send an SMS to the account manager with Rule 3 retry.
 * No-ops if phone numbers are not configured.
 */
async function sendManagerAlert(
  account: {
    id: string;
    manager_phone: string;
    twilio_phone_number: string | null;
    alert_channel: string;
  },
  body: string,
): Promise<void> {
  if (!account.twilio_phone_number || !account.manager_phone) {
    logger.warn({ accountId: account.id }, 'Twilio phone numbers not configured — skipping manager alert');
    return;
  }

  const send = _hooks.sendSms ?? defaultSendSms;

  try {
    await send(account.manager_phone, account.twilio_phone_number, body);
  } catch (firstErr) {
    logger.warn({ err: firstErr, accountId: account.id }, 'manager alert SMS failed — retrying (Rule 3)');
    await sleep(_hooks.retryDelayMs);
    try {
      await send(account.manager_phone, account.twilio_phone_number, body);
    } catch (secondErr) {
      logger.error({ err: secondErr, accountId: account.id }, 'manager alert SMS permanently failed after retry');
    }
  }
}

// ── T-024 — Booking Cancellation Handler ─────────────────────────────────────

export async function handleBookingCancellation(
  bookingId: string,
  accountId: string,
): Promise<void> {
  const booking = await prisma.bookings.findUnique({
    where: { id: bookingId },
    include: {
      property: { select: { id: true, name: true } },
      account:  {
        select: {
          id: true,
          business_name: true,
          manager_phone: true,
          twilio_phone_number: true,
          alert_channel: true,
        },
      },
    },
  });

  if (!booking) {
    logger.warn({ bookingId }, 'handleBookingCancellation: booking not found');
    return;
  }

  // ── Case C: already completed — discard silently ────────────────────────
  if (booking.status === 'completed') {
    logger.info(
      { bookingId, status: booking.status },
      'cancellation event for completed booking — discarding',
    );
    return;
  }

  // ── Case A: upcoming — cancel only ──────────────────────────────────────
  if (booking.status === 'upcoming') {
    await prisma.bookings.update({
      where: { id: bookingId },
      data:  { status: 'cancelled' },
    });
    logger.info({ bookingId }, 'Case A: upcoming booking cancelled');
    return;
  }

  // ── Case B: active — transactional cancel + clean-up + alert ────────────
  if (booking.status === 'active') {
    await prisma.$transaction([
      prisma.bookings.update({
        where: { id: bookingId },
        data:  { status: 'cancelled' },
      }),
      prisma.cleaning_jobs.updateMany({
        where: {
          booking_id: bookingId,
          status:     { in: ['scheduled', 'confirmed', 'no_response'] },
        },
        data: { status: 'failed' },
      }),
      prisma.properties.update({
        where: { id: booking.property.id },
        data:  { property_status: 'unknown' },
      }),
    ]);

    logger.info({ bookingId }, 'Case B: active booking cancelled — cleaning job failed, property_status set to unknown');

    const alertText =
      `BOOKING CANCELLED: Guest ${booking.guest_first_name} ${booking.guest_last_name}` +
      ` at ${booking.property.name} cancelled mid-stay.` +
      ` Any pending cleaning job has been marked failed.` +
      ` Please verify property status and manage manually. - ${booking.account.business_name}`;

    await sendManagerAlert(booking.account, alertText);
    return;
  }

  // Already cancelled or unknown status — nothing to do
  logger.info({ bookingId, status: booking.status }, 'cancellation event for booking with no-op status — skipping');
}

// ── Core upsert logic (T-023) ────────────────────────────────────────────────

async function processBooking(
  platform: 'airbnb' | 'vrbo',
  payload: BookingPayload,
): Promise<void> {
  const listingField = platform === 'airbnb' ? 'airbnb_listing_id' : 'vrbo_listing_id';

  const property = await prisma.properties.findFirst({
    where: { [listingField]: payload.listing_id },
    select: { id: true, account_id: true },
  });

  if (!property) {
    logger.warn(
      { platform, listing_id: payload.listing_id },
      'no property found for listing_id — skipping booking upsert',
    );
    return;
  }

  const { id: property_id, account_id } = property;

  if (payload.status === 'cancelled') {
    const existing = await prisma.bookings.findUnique({
      where: {
        account_id_platform_platform_booking_id: {
          account_id,
          platform,
          platform_booking_id: payload.platform_booking_id,
        },
      },
      select: { id: true },
    });

    if (existing) {
      const cancel = _hooks.handleCancellation ?? handleBookingCancellation;
      await cancel(existing.id, account_id);
    } else {
      logger.warn(
        { platform, platform_booking_id: payload.platform_booking_id },
        'cancellation received for unknown booking — ignoring',
      );
    }
    return;
  }

  await prisma.bookings.upsert({
    where: {
      account_id_platform_platform_booking_id: {
        account_id,
        platform,
        platform_booking_id: payload.platform_booking_id,
      },
    },
    create: {
      account_id,
      property_id,
      platform,
      platform_booking_id:  payload.platform_booking_id,
      guest_platform_id:    payload.guest_platform_user_id,
      guest_first_name:     payload.guest_first_name,
      guest_last_name:      payload.guest_last_name,
      checkin_datetime:     new Date(payload.checkin_datetime),
      checkout_datetime:    new Date(payload.checkout_datetime),
      status:               'upcoming',
    },
    update: {
      guest_platform_id:  payload.guest_platform_user_id,
      guest_first_name:   payload.guest_first_name,
      guest_last_name:    payload.guest_last_name,
      checkin_datetime:   new Date(payload.checkin_datetime),
      checkout_datetime:  new Date(payload.checkout_datetime),
    },
  });

  logger.info(
    { platform, platform_booking_id: payload.platform_booking_id },
    'booking upserted',
  );
}

// ── pg-boss handler wrappers ─────────────────────────────────────────────────

export async function processAirbnbBookingHandler(job: { data: unknown }): Promise<void> {
  await processBooking('airbnb', job.data as BookingPayload);
}

export async function processVrboBookingHandler(job: { data: unknown }): Promise<void> {
  await processBooking('vrbo', job.data as BookingPayload);
}

// ── Scheduled sweep stub (T-025 implements) ──────────────────────────────────

export async function bookingSyncSweepHandler(): Promise<void> {
  logger.info('booking-sync-sweep fired (stub — T-025 implements full reconciliation)');
}
