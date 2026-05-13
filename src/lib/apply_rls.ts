/**
 * Applies RLS migration: idempotent — drops policies before recreating them.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
import { PrismaClient } from '@prisma/client';

const TABLES = [
  'accounts',
  'properties',
  'bookings',
  'messages',
  'cleaners',
  'property_cleaners',
  'turnover_checklists',
  'cleaning_jobs',
  'work_orders',
  'review_drafts',
];

(async () => {
  const prisma = new PrismaClient();
  try {
    for (const table of TABLES) {
      // Enable RLS (idempotent)
      await (prisma as any).$executeRawUnsafe(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`
      );

      // Drop existing policy if present, then recreate
      const policyName = table === 'accounts'
        ? 'accounts_isolation'
        : `${table}_account_isolation`;

      await (prisma as any).$executeRawUnsafe(
        `DROP POLICY IF EXISTS ${policyName} ON ${table}`
      );

      const using = table === 'accounts'
        ? `id = auth.uid()::text`
        : `account_id = auth.uid()::text`;

      await (prisma as any).$executeRawUnsafe(
        `CREATE POLICY ${policyName} ON ${table} FOR ALL USING (${using})`
      );

      console.log(`  OK  ${table}`);
    }

    // Record in _prisma_migrations (idempotent)
    await (prisma as any).$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      SELECT gen_random_uuid()::text, 'manual', now(),
             '20260418000008_rls_policies', NULL, NULL, now(), 1
      WHERE NOT EXISTS (
        SELECT 1 FROM "_prisma_migrations"
        WHERE migration_name = '20260418000008_rls_policies'
      )
    `);

    console.log('\nRLS migration applied and recorded.');
  } catch (e: unknown) {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
