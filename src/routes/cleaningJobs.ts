/**
 * T-045 — GET /api/cleaning-jobs
 *        + PATCH /api/cleaning-jobs/:id
 *        + PATCH /api/cleaning-jobs/:id/dismiss-damage
 *
 * Powers the Turnover Status, Supply Alerts, and Damage Reports panels.
 *
 * ISSUE-18 fix: Manual close must set properties.property_status = 'guest_ready'
 * in the SAME transaction as the cleaning_jobs status update.
 */

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

const router = Router();

// ── GET /api/cleaning-jobs ────────────────────────────────────────────────────

router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId        = req.accountId!;
      const { supply_alerts, damage_reports } = req.query;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: Record<string, any> = { account_id: accountId };

      if (supply_alerts === 'true') {
        where.supply_alert_sent      = true;
        where.supply_alert_dismissed = false;
      }

      if (damage_reports === 'true') {
        where.damage_fyi_sent         = true;
        where.damage_report_dismissed = false;
        where.work_orders             = { none: {} };
      }

      const jobs = await prisma.cleaning_jobs.findMany({
        where,
        orderBy: { scheduled_start: 'desc' },
        include: {
          property:     { select: { id: true, name: true, address: true } },
          cleaner:      { select: { id: true, name: true, phone: true } },
          next_booking: {
            select: {
              id:               true,
              checkin_datetime: true,
              guest_first_name: true,
              guest_last_name:  true,
            },
          },
        },
      });

      res.json({ data: jobs });
    } catch (err) {
      logger.error({ err }, 'GET /api/cleaning-jobs error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── PATCH /api/cleaning-jobs/:id/dismiss-damage ───────────────────────────────
// Must be registered before /:id to avoid Express treating 'dismiss-damage' as the :id param.

router.patch(
  '/:id/dismiss-damage',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id }    = req.params;

      const job = await prisma.cleaning_jobs.findUnique({
        where:  { id },
        select: { id: true, account_id: true },
      });

      if (!job || job.account_id !== accountId) {
        res.status(404).json({ error: 'Cleaning job not found' });
        return;
      }

      const updated = await prisma.cleaning_jobs.update({
        where: { id },
        data:  { damage_report_dismissed: true },
      });

      res.json({ data: updated });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/cleaning-jobs/:id/dismiss-damage error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── PATCH /api/cleaning-jobs/:id ──────────────────────────────────────────────

router.patch(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id }    = req.params;
      const body      = req.body ?? {};

      const job = await prisma.cleaning_jobs.findUnique({
        where:  { id },
        select: { id: true, account_id: true, property_id: true },
      });

      if (!job || job.account_id !== accountId) {
        res.status(404).json({ error: 'Cleaning job not found' });
        return;
      }

      // Manual close path — ISSUE-18 fix: both updates in one transaction
      if (body.closed_by === 'manager_manual') {
        const [updatedJob] = await prisma.$transaction([
          prisma.cleaning_jobs.update({
            where: { id },
            data: {
              status:       'completed',
              closed_by:    'manager_manual',
              completed_at: new Date(),
            },
          }),
          prisma.properties.update({
            where: { id: job.property_id },
            data:  { property_status: 'guest_ready' },
          }),
        ]);
        res.json({ data: updatedJob });
        return;
      }

      // Supply alert dismiss path
      if (body.supply_alert_dismissed === true) {
        const updated = await prisma.cleaning_jobs.update({
          where: { id },
          data:  { supply_alert_dismissed: true },
        });
        res.json({ data: updated });
        return;
      }

      res.status(400).json({ error: 'No valid update field provided' });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/cleaning-jobs/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
