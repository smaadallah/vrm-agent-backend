/**
 * T-037 — GET /api/search?q=
 */

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

const router = Router();

router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const q = (req.query['q'] as string | undefined) ?? '';

      if (!q || q.trim() === '') {
        res.json({ data: [] });
        return;
      }

      if (q.length > 100) {
        res.status(400).json({ error: 'q must be 100 characters or fewer' });
        return;
      }

      const [bookings, properties] = await Promise.all([
        prisma.bookings.findMany({
          where: {
            account_id: accountId,
            OR: [
              { guest_first_name:    { contains: q, mode: 'insensitive' } },
              { guest_last_name:     { contains: q, mode: 'insensitive' } },
              { platform_booking_id: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: {
            id:               true,
            guest_first_name: true,
            guest_last_name:  true,
            property_id:      true,
          },
          take: 20,
        }),
        prisma.properties.findMany({
          where: {
            account_id: accountId,
            name: { contains: q, mode: 'insensitive' },
          },
          select: { id: true, name: true },
          take: 20,
        }),
      ]);

      const results = [
        ...bookings.map(b => ({
          type:         'booking',
          id:           b.id,
          display_name: `${b.guest_first_name} ${b.guest_last_name}`,
          url:          `/properties/${b.property_id}/messages/${b.id}`,
        })),
        ...properties.map(p => ({
          type:         'property',
          id:           p.id,
          display_name: p.name,
          url:          `/properties/${p.id}`,
        })),
      ];

      res.json({ data: results });
    } catch (err) {
      logger.error({ err }, 'GET /api/search error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
