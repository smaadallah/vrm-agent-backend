/**
 * T-046 — POST /api/work-orders — Manager-Initiated Work Order (Trigger B)
 * T-047 — GET /api/work-orders + PATCH /api/work-orders/:id
 *
 * ISSUE-10 fix: reported_by is ALWAYS set server-side from source_cleaning_job_id.
 * The request body value is never used.
 */

import { Router, Request, Response } from 'express';
import { WorkOrderPriority, WorkOrderStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';
import { generateAiSummary } from '../jobs/workOrderCreation';

const router = Router();

/** Test injection hook for AI call override. */
export const _hooks: {
  aiCall: ((prompt: string) => Promise<string>) | undefined;
} = { aiCall: undefined };

const VALID_PRIORITIES: WorkOrderPriority[] = ['urgent', 'high', 'medium', 'low'];
const VALID_STATUSES:   WorkOrderStatus[]   = ['open', 'in_progress', 'resolved'];

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high:   1,
  medium: 2,
  low:    3,
};

const RESOLVED_PAGE_SIZE = 50;

// ── POST /api/work-orders ──────────────────────────────────────────────────────

router.post(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const body      = req.body ?? {};

      const { property_id, description, priority, booking_id, source_cleaning_job_id, source_message_id } = body;

      if (!property_id || !description || !priority) {
        res.status(400).json({ error: 'property_id, description, and priority are required' });
        return;
      }

      if (!VALID_PRIORITIES.includes(priority)) {
        res.status(400).json({ error: 'priority must be urgent, high, medium, or low' });
        return;
      }

      // ISSUE-10: reported_by is server-set only — never taken from the request body.
      const reported_by = source_cleaning_job_id ? 'cleaner' : 'manager';

      const ai_summary = await generateAiSummary(description, _hooks.aiCall ?? undefined);

      const workOrder = await prisma.work_orders.create({
        data: {
          account_id:              accountId,
          property_id,
          booking_id:              booking_id              ?? null,
          reported_by,
          description,
          ai_summary,
          priority,
          status:                  'open',
          source_message_id:       source_message_id       ?? null,
          source_cleaning_job_id:  source_cleaning_job_id  ?? null,
        },
      });

      res.status(201).json({ data: workOrder });
    } catch (err) {
      logger.error({ err }, 'POST /api/work-orders error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── GET /api/work-orders ──────────────────────────────────────────────────────
// Returns active (open + in_progress, priority-sorted) and resolved (paginated).

router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId   = req.accountId!;
      const property_id = req.query.property_id as string | undefined;
      const page        = Math.max(1, parseInt(req.query.page as string) || 1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const baseWhere: Record<string, any> = { account_id: accountId };
      if (property_id) baseWhere.property_id = property_id;

      const include = { property: { select: { name: true } } };

      // Active list — all open/in_progress; sorted in application code below.
      const active = await prisma.work_orders.findMany({
        where:   { ...baseWhere, status: { in: ['open', 'in_progress'] } },
        include,
      });

      active.sort((a, b) => {
        const diff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        return diff !== 0 ? diff : a.created_at.getTime() - b.created_at.getTime();
      });

      // Resolved archive — sorted resolved_at DESC, paginated 50/page.
      const [resolved, resolved_total] = await Promise.all([
        prisma.work_orders.findMany({
          where:   { ...baseWhere, status: 'resolved' },
          include,
          orderBy: { resolved_at: 'desc' },
          skip:    (page - 1) * RESOLVED_PAGE_SIZE,
          take:    RESOLVED_PAGE_SIZE,
        }),
        prisma.work_orders.count({ where: { ...baseWhere, status: 'resolved' } }),
      ]);

      res.json({ data: { active, resolved, resolved_total, page } });
    } catch (err) {
      logger.error({ err }, 'GET /api/work-orders error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── PATCH /api/work-orders/:id ────────────────────────────────────────────────

router.patch(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id }    = req.params;
      const body      = req.body ?? {};
      const { status, priority, manager_notes, updated_at_check } = body;

      const existing = await prisma.work_orders.findUnique({
        where:  { id },
        select: { id: true, account_id: true, updated_at: true },
      });

      if (!existing || existing.account_id !== accountId) {
        res.status(404).json({ error: 'Work order not found' });
        return;
      }

      // Concurrent edit detection — 409 if updated_at has changed since client loaded.
      if (updated_at_check !== undefined) {
        const checkMs = new Date(updated_at_check).getTime();
        if (Number.isNaN(checkMs) || checkMs !== existing.updated_at.getTime()) {
          res.status(409).json({ error: 'Work order was updated elsewhere. Reload to see the latest version.' });
          return;
        }
      }

      // Validate enum fields if provided.
      if (status !== undefined && !VALID_STATUSES.includes(status)) {
        res.status(400).json({ error: 'Invalid status value' });
        return;
      }
      if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
        res.status(400).json({ error: 'Invalid priority value' });
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateData: Record<string, any> = {};
      if (status        !== undefined) updateData.status        = status;
      if (priority      !== undefined) updateData.priority      = priority;
      if (manager_notes !== undefined) updateData.manager_notes = manager_notes;

      // Resolve path — set resolved_at and resolved_by server-side.
      if (status === 'resolved') {
        updateData.resolved_at = new Date();
        updateData.resolved_by = 'manager';
      }

      if (Object.keys(updateData).length === 0) {
        res.status(400).json({ error: 'No valid update field provided' });
        return;
      }

      const updated = await prisma.work_orders.update({
        where: { id },
        data:  updateData,
      });

      res.json({ data: updated });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/work-orders/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
