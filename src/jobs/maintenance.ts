/**
 * T-031 — Daily Maintenance Jobs
 *
 * ai-token-cap-reset (00:00 ET):
 *   Resets accounts.daily_ai_token_usage = 0 and sets ai_token_cap_reset_at = now()
 *   for every account. Prevents permanent lockout after the daily cap is first reached.
 *   PRD Section 4, Rule 6.
 *
 * guest-pii-retention-purge (03:00 ET):
 *   Deletes all messages rows tied to bookings whose checkout_datetime is older than
 *   12 months. Clears identifying PII fields on those bookings. GDPR / CCPA compliance.
 *   Architecture Section 9.4.
 */

import prisma from '../lib/prisma';
import logger from '../lib/logger';

/**
 * Resets the daily AI token counter for all accounts.
 * Registered as the 'ai-token-cap-reset' pg-boss handler.
 */
export async function aiTokenCapResetHandler(): Promise<void> {
  const result = await prisma.accounts.updateMany({
    data: {
      daily_ai_token_usage: 0,
      ai_token_cap_reset_at: new Date(),
    },
  });

  logger.info({ count: result.count }, 'ai-token-cap-reset: reset daily_ai_token_usage for all accounts');
}

/**
 * Purges guest PII for bookings whose checkout was more than 12 months ago.
 * Registered as the 'guest-pii-retention-purge' pg-boss handler.
 *
 * Sequence:
 *   1. Find old booking IDs (checkout_datetime < 12 months ago)
 *   2. Delete all messages rows for those bookings
 *      (work_orders.source_message_id is automatically set NULL via ON DELETE SET NULL)
 *   3. Clear identifying fields on those bookings (keep the booking row for audit trail)
 */
export async function guestPiiPurgeHandler(): Promise<void> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);

  // Step 1: Identify bookings past the retention window
  const oldBookings = await prisma.bookings.findMany({
    where: { checkout_datetime: { lt: cutoff } },
    select: { id: true },
  });

  const bookingIds = oldBookings.map(b => b.id);

  if (bookingIds.length === 0) {
    logger.info({ deletedMessages: 0, redactedBookings: 0 }, 'guest-pii-retention-purge: no bookings past retention window');
    return;
  }

  // Step 2: Delete messages for those bookings
  const { count: deletedMessages } = await prisma.messages.deleteMany({
    where: { booking_id: { in: bookingIds } },
  });

  // Step 3: Clear identifying PII fields — keep booking row for audit trail
  const { count: redactedBookings } = await prisma.bookings.updateMany({
    where: { id: { in: bookingIds } },
    data: {
      guest_first_name: '[redacted]',
      guest_last_name:  '[redacted]',
      guest_platform_id: '[redacted]',
    },
  });

  logger.info(
    { deletedMessages, redactedBookings, cutoff },
    'guest-pii-retention-purge: completed',
  );
}
