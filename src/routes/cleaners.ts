/**
 * T-036 — POST /api/cleaners + GET /api/cleaners + PATCH /api/cleaners/:id
 */

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

const router = Router();

// E.164: + followed by a non-zero country digit, then 1–14 more digits (total 3–16 chars)
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

// POST /api/cleaners
router.post(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { name, phone, email } = req.body ?? {};

      if (typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ error: 'name is required' });
        return;
      }

      if (typeof phone !== 'string' || phone.trim() === '') {
        res.status(400).json({
          error: 'phone is required and must be in E.164 format (e.g. +13055550001)',
        });
        return;
      }

      if (!E164_REGEX.test(phone)) {
        res.status(400).json({
          error: 'phone must be in E.164 format (e.g. +13055550001)',
        });
        return;
      }

      const cleaner = await prisma.cleaners.create({
        data: {
          account_id: accountId,
          name: name.trim(),
          phone,
          email: email ?? null,
        },
      });

      res.status(201).json({ data: cleaner });
    } catch (err) {
      logger.error({ err }, 'POST /api/cleaners error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /api/cleaners
router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;

      const cleaners = await prisma.cleaners.findMany({
        where:   { account_id: accountId },
        orderBy: { name: 'asc' },
        include: {
          property_cleaners: {
            include: {
              property: { select: { id: true, name: true } },
            },
          },
        },
      });

      res.json({ data: cleaners });
    } catch (err) {
      logger.error({ err }, 'GET /api/cleaners error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// PATCH /api/cleaners/:id
router.patch(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id } = req.params;
      const body = req.body ?? {};

      // Verify cleaner belongs to this account
      const existing = await prisma.cleaners.findUnique({ where: { id } });
      if (!existing || existing.account_id !== accountId) {
        res.status(404).json({ error: 'Cleaner not found' });
        return;
      }

      // Re-validate phone format if it is being updated
      if (body.phone !== undefined && !E164_REGEX.test(body.phone)) {
        res.status(400).json({
          error: 'phone must be in E.164 format (e.g. +13055550001)',
        });
        return;
      }

      // Deactivation cascade check: if is_active is being set to false,
      // block if the cleaner is still a primary on any property.
      if (body.is_active === false) {
        const primaryAssignments = await prisma.property_cleaners.findMany({
          where: { cleaner_id: id, is_primary: true },
          include: { property: { select: { id: true, name: true } } },
        });

        if (primaryAssignments.length > 0) {
          res.status(400).json({
            error: 'Cannot deactivate: cleaner is the primary cleaner for one or more properties. Reassign a primary cleaner before deactivating.',
            properties: primaryAssignments.map(pc => ({
              id:   pc.property.id,
              name: pc.property.name,
            })),
          });
          return;
        }
      }

      // Build update payload from allowed fields
      const updateData: Record<string, unknown> = {};
      if (body.name      !== undefined) updateData.name      = typeof body.name === 'string' ? body.name.trim() : body.name;
      if (body.phone     !== undefined) updateData.phone     = body.phone;
      if (body.email     !== undefined) updateData.email     = body.email;
      if (body.is_active !== undefined) updateData.is_active = body.is_active;

      const updated = await prisma.cleaners.update({
        where: { id },
        data:  updateData,
      });

      res.json({ data: updated });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/cleaners/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
