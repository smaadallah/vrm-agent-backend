/**
 * T-033 — GET /api/bookings — Booking list with message send status booleans and pagination
 */

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

const router = Router();

// GET /api/bookings
router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { page, limit } = req.query;

      const pageNum  = Math.max(1, parseInt(String(page  ?? '1'),  10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(String(limit ?? '50'), 10) || 50));
      const skip     = (pageNum - 1) * limitNum;

      const bookings = await prisma.bookings.findMany({
        where:   { account_id: accountId },
        orderBy: { checkin_datetime: 'desc' },
        skip,
        take: limitNum,
        select: {
          id:                       true,
          account_id:               true,
          property_id:              true,
          platform:                 true,
          platform_booking_id:      true,
          guest_first_name:         true,
          guest_last_name:          true,
          guest_platform_id:        true,
          checkin_datetime:         true,
          checkout_datetime:        true,
          status:                   true,
          checkin_message_sent:     true,
          checkout_reminder_sent:   true,
          review_request_sent:      true,
          checkin_message_sent_at:  true,
          checkout_reminder_sent_at: true,
          review_request_sent_at:   true,
          created_at:               true,
          property: { select: { name: true } },
        },
      });

      res.json({ data: bookings, page: pageNum, limit: limitNum });
    } catch (err) {
      logger.error({ err }, 'GET /api/bookings error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
