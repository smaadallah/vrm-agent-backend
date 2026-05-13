/**
 * Generic migration applier: reads a migration SQL file, executes each statement,
 * and records the migration in _prisma_migrations.
 *
 * Usage: MIGRATION_NAME=xxx npx ts-node src/lib/apply_migration.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
import { PrismaClient } from '@prisma/client';

const migrationName = process.env.MIGRATION_NAME;
if (!migrationName) { console.error('Set MIGRATION_NAME env var'); process.exit(1); }

(async () => {
  const prisma = new PrismaClient();
  const sqlPath = path.join(__dirname, '..', '..', 'prisma', 'migrations', migrationName, 'migration.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const statements = sql
    .split(/;\s*\n/)
    .map(chunk => chunk.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0);

  try {
    for (const stmt of statements) {
      console.log('Executing:', stmt.slice(0, 70).replace(/\n/g, ' '));
      await (prisma as any).$executeRawUnsafe(stmt);
    }
    console.log('SQL applied.');

    await (prisma as any).$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      SELECT gen_random_uuid()::text, 'manual', now(), '${migrationName}', NULL, NULL, now(), 1
      WHERE NOT EXISTS (
        SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '${migrationName}'
      )
    `);
    console.log('Migration recorded.');
  } catch (e: unknown) {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
