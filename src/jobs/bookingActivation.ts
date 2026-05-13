/**
 * T-025 — Feature 1.6 — Booking Activation Sweep
 *
 * Hourly sweep: transitions bookings from 'upcoming' → 'active' once
 * checkin_datetime has passed, then sets property_status = 'occupied'.
 * Atomic conditional UPDATE prevents double-activation under concurrent runs.
 */

import prisma from '../lib/prisma';
import logger from '../lib/logger';

// Injectable override for testing the atomic activation step without live DB.
export const _hooks = {
  atomicActivate: undefined as
    | ((bookingId: string, propertyId: string) => Promise<boolean>)
    | undefined,
};

/**
 * Atomically transitions a single booking from 'upcoming' to 'active'.
 * Runs both the status update and the property_status update in one transaction.
 *
 * Returns true if the booking was activated (1 row affected), false if it was
 * already activated by a concurrent job run (0 rows affected).
 */
async function atomicActivateBooking(bookingId: string, propertyId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const affected = await tx.$executeRaw`
      UPDATE bookings
      SET    status = 'active'
      WHERE  id     = ${bookingId}
        AND  status = 'upcoming'
    `;

    if (affected === 0) return false;

    await tx.properties.update({
      where: { id: propertyId },
      data:  { property_status: 'occupied' },
    });

    return true;
  });
}

/**
 * Main handler registered with pg-boss.
 * Queries for all upcoming bookings whose check-in time has passed and
 * attempts to activate each one atomically.
 */
export async function bookingActivationSweepHandler(): Promise<void> {
  const now = new Date();

  const candidates = await prisma.bookings.findMany({
    where: {
      status:           'upcoming',
      checkin_datetime: { lte: now },
    },
    select: { id: true, property_id: true },
  });

  if (candidates.length === 0) {
    logger.info('booking-activation-sweep: no candidates found');
    return;
  }

  logger.info({ count: candidates.length }, 'booking-activation-sweep: candidates found');

  const activate = _hooks.atomicActivate ?? atomicActivateBooking;

  for (const { id: booking_id, property_id } of candidates) {
    const activated = await activate(booking_id, property_id);

    if (!activated) {
      logger.info({ booking_id }, 'booking-activation-sweep: booking already active — skipped');
      continue;
    }

    logger.info(
      { booking_id, property_id, activated_at: now.toISOString() },
      'booking-activation-sweep: booking activated',
    );
  }
}
