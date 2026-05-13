/**
 * T-034 — GET /api/properties + POST /api/properties + GET /api/properties/:id
 * T-035 — PATCH /api/properties/:id
 */

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { authMiddleware } from '../middleware/auth';
import { accountIsolationMiddleware } from '../middleware/accountIsolation';

const router = Router();

const REQUIRED_FIELDS = ['name', 'address', 'checkin_time', 'checkout_time'] as const;

// GET /api/properties
router.get(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;

      const properties = await prisma.properties.findMany({
        where:   { account_id: accountId },
        orderBy: { name: 'asc' },
      });

      res.json({ data: properties });
    } catch (err) {
      logger.error({ err }, 'GET /api/properties error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /api/properties
router.post(
  '/',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const body = req.body ?? {};

      for (const field of REQUIRED_FIELDS) {
        const val = body[field];
        if (typeof val !== 'string' || val.trim() === '') {
          res.status(400).json({ error: `${field} is required` });
          return;
        }
      }

      const property = await prisma.$transaction(async (tx) => {
        const created = await tx.properties.create({
          data: {
            account_id:                          accountId,
            name:                                body.name.trim(),
            address:                             body.address.trim(),
            checkin_time:                        body.checkin_time.trim(),
            checkout_time:                       body.checkout_time.trim(),
            door_access_instructions:            body.door_access_instructions    ?? null,
            parking_instructions:                body.parking_instructions        ?? null,
            wifi_name:                           body.wifi_name                   ?? null,
            wifi_password:                       body.wifi_password               ?? null,
            house_rules:                         body.house_rules                 ?? null,
            amenities:                           body.amenities                   ?? null,
            local_recommendations:               body.local_recommendations       ?? null,
            special_instructions:                body.special_instructions        ?? null,
            checkout_steps:                      body.checkout_steps              ?? null,
            checkin_message_template:            body.checkin_message_template    ?? null,
            checkout_reminder_template:          body.checkout_reminder_template  ?? null,
            review_request_template:             body.review_request_template     ?? null,
            checkin_message_enabled:             body.checkin_message_enabled             ?? true,
            checkout_reminder_enabled:           body.checkout_reminder_enabled           ?? true,
            review_request_enabled:              body.review_request_enabled              ?? true,
            checkin_message_hours_before:        body.checkin_message_hours_before        ?? 24,
            checkout_reminder_send_time:         body.checkout_reminder_send_time         ?? '20:00',
            review_request_hours_after:          body.review_request_hours_after          ?? 2,
            airbnb_listing_id:                   body.airbnb_listing_id                   ?? null,
            vrbo_listing_id:                     body.vrbo_listing_id                     ?? null,
            auto_schedule_cleaner_enabled:       body.auto_schedule_cleaner_enabled       ?? true,
            cleaner_confirmation_window_minutes: body.cleaner_confirmation_window_minutes ?? 60,
            pre_checkin_alert_minutes:           body.pre_checkin_alert_minutes           ?? 30,
          },
        });

        await tx.turnover_checklists.create({
          data: {
            account_id:    accountId,
            property_id:   created.id,
            checklist_body: '',
          },
        });

        return created;
      });

      res.status(201).json({ data: property });
    } catch (err) {
      logger.error({ err }, 'POST /api/properties error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /api/properties/:id
router.get(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id } = req.params;

      const property = await prisma.properties.findUnique({
        where: { id },
        include: {
          turnover_checklists: {
            select: { checklist_body: true },
            take: 1,
          },
          property_cleaners: {
            include: { cleaner: true },
          },
        },
      });

      if (!property || property.account_id !== accountId) {
        res.status(404).json({ error: 'Property not found' });
        return;
      }

      const { turnover_checklists, property_cleaners, ...fields } = property;

      res.json({
        data: {
          ...fields,
          checklist_body: turnover_checklists[0]?.checklist_body ?? '',
          cleaners: property_cleaners.map(pc => ({
            ...pc.cleaner,
            is_primary: pc.is_primary,
          })),
        },
      });
    } catch (err) {
      logger.error({ err }, 'GET /api/properties/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Fields on the properties row that may be updated via PATCH
const UPDATABLE_PROPERTY_FIELDS = [
  'name', 'address', 'checkin_time', 'checkout_time',
  'door_access_instructions', 'parking_instructions',
  'wifi_name', 'wifi_password',
  'house_rules', 'amenities', 'local_recommendations',
  'special_instructions', 'checkout_steps',
  'checkin_message_template', 'checkout_reminder_template', 'review_request_template',
  'checkin_message_enabled', 'checkout_reminder_enabled', 'review_request_enabled',
  'checkin_message_hours_before', 'checkout_reminder_send_time', 'review_request_hours_after',
  'airbnb_listing_id', 'vrbo_listing_id',
  'auto_schedule_cleaner_enabled', 'cleaner_confirmation_window_minutes', 'pre_checkin_alert_minutes',
] as const;

// PATCH /api/properties/:id
router.patch(
  '/:id',
  authMiddleware,
  accountIsolationMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const accountId = req.accountId!;
      const { id } = req.params;
      const body = req.body ?? {};

      // Step 1: Verify property belongs to account
      const existing = await prisma.properties.findUnique({ where: { id } });
      if (!existing || existing.account_id !== accountId) {
        res.status(404).json({ error: 'Property not found' });
        return;
      }

      // Step 2: auto_schedule_cleaner_enabled constraint
      // If auto-schedule will be enabled after this update, a primary cleaner must exist.
      // Providing primary_cleaner_id in the same request satisfies the constraint.
      const finalAutoSchedule = body.auto_schedule_cleaner_enabled !== undefined
        ? body.auto_schedule_cleaner_enabled
        : existing.auto_schedule_cleaner_enabled;

      if (finalAutoSchedule === true && !body.primary_cleaner_id) {
        const existingPrimary = await prisma.property_cleaners.findFirst({
          where: {
            property_id: id,
            is_primary: true,
            cleaner: { is_active: true },
          },
        });
        if (!existingPrimary) {
          res.status(400).json({
            error: 'A primary cleaner must be assigned before enabling auto-schedule',
          });
          return;
        }
      }

      // Step 3: Collect property-row field updates
      const propertyData: Record<string, unknown> = {};
      for (const field of UPDATABLE_PROPERTY_FIELDS) {
        if (field in body) propertyData[field] = body[field];
      }

      // Step 4: Run all DB changes in a single transaction
      await prisma.$transaction(async (tx) => {
        if (Object.keys(propertyData).length > 0) {
          await tx.properties.update({ where: { id }, data: propertyData });
        }

        // Upsert turnover_checklists row if checklist_body was supplied
        if ('checklist_body' in body) {
          const row = await tx.turnover_checklists.findFirst({ where: { property_id: id } });
          if (row) {
            await tx.turnover_checklists.update({
              where: { id: row.id },
              data:  { checklist_body: body.checklist_body },
            });
          } else {
            await tx.turnover_checklists.create({
              data: {
                account_id:    accountId,
                property_id:   id,
                checklist_body: body.checklist_body ?? '',
              },
            });
          }
        }

        // Update primary cleaner assignment if supplied
        if (body.primary_cleaner_id) {
          // Demote any existing primary for this property
          await tx.property_cleaners.updateMany({
            where: { property_id: id, is_primary: true },
            data:  { is_primary: false },
          });

          // Promote the new primary — update existing row or create one
          const cleanerRow = await tx.property_cleaners.findFirst({
            where: { property_id: id, cleaner_id: body.primary_cleaner_id },
          });
          if (cleanerRow) {
            await tx.property_cleaners.update({
              where: { id: cleanerRow.id },
              data:  { is_primary: true },
            });
          } else {
            await tx.property_cleaners.create({
              data: {
                account_id: accountId,
                property_id: id,
                cleaner_id:  body.primary_cleaner_id,
                is_primary:  true,
              },
            });
          }
        }
      });

      // Return the updated property row
      const updated = await prisma.properties.findUnique({ where: { id } });
      res.json({ data: updated });
    } catch (err) {
      logger.error({ err }, 'PATCH /api/properties/:id error');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
