import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;

import { PrismaClient } from '@prisma/client';

(async () => {
  const prisma = new PrismaClient();
  try {
    await (prisma as any).$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS property_cleaners_one_primary_per_property
        ON property_cleaners (property_id)
        WHERE is_primary = true
    `);
    console.log('Partial index created.');

    // Mark migration as applied in _prisma_migrations table
    await (prisma as any).$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      VALUES (
        gen_random_uuid()::text,
        'manual',
        now(),
        '20260417212700_cleaners_partial_index',
        NULL,
        NULL,
        now(),
        1
      )
      ON CONFLICT DO NOTHING
    `);
    console.log('Migration recorded.');
  } catch (e: unknown) {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
