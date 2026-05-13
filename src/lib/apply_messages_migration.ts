import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
import { PrismaClient } from '@prisma/client';

(async () => {
  const prisma = new PrismaClient();
  const sqlPath = path.join(__dirname, '..', '..', 'prisma', 'migrations',
    '20260418000004_create_messages_table', 'migration.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Split on semicolon+newline, strip leading comment lines from each chunk,
  // then execute any chunk that has a non-comment SQL statement.
  const statements = sql
    .split(/;\s*\n/)
    .map(chunk => {
      // Remove leading comment lines (-- ...) to get executable SQL
      const lines = chunk.split('\n');
      const sqlLines = lines.filter(l => !l.trimStart().startsWith('--'));
      return sqlLines.join('\n').trim();
    })
    .filter(s => s.length > 0);

  try {
    for (const stmt of statements) {
      console.log('Executing:', stmt.slice(0, 60).replace(/\n/g, ' ') + '...');
      await (prisma as any).$executeRawUnsafe(stmt);
    }
    console.log('Migration SQL applied.');

    await (prisma as any).$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
      VALUES (
        gen_random_uuid()::text, 'manual', now(),
        '20260418000004_create_messages_table',
        NULL, NULL, now(), 1
      ) ON CONFLICT DO NOTHING
    `);
    console.log('Migration recorded.');
  } catch (e: unknown) {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
