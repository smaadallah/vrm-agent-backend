/**
 * Verification script for T-012: Supabase RLS Policies — All Tables
 *
 * AC1  RLS is enabled on all 10 tables
 * AC2  Each table has the correct isolation policy
 * AC3  A query without valid auth context returns 0 rows on any protected table
 * AC4  All SQL documented in migration file
 *
 * Run with: npx ts-node src/lib/t012.verify.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;
import { PrismaClient } from '@prisma/client';
// Use pg directly for role-switching in a single connection/transaction
import { Client } from 'pg';

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}`); failed++; }
}

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

const backendRoot = path.join(__dirname, '..', '..');

(async () => {
  const prisma = new PrismaClient();

  try {
    // ── AC1: RLS enabled on all 10 tables ─────────────────────────────────────
    console.log('\nAC1 — RLS enabled on all 10 tables');
    {
      const rows = await (prisma as any).$queryRaw`
        SELECT relname, relrowsecurity
        FROM pg_class
        WHERE relname = ANY(ARRAY[
          'accounts','properties','bookings','messages','cleaners',
          'property_cleaners','turnover_checklists','cleaning_jobs',
          'work_orders','review_drafts'
        ])
        AND relkind = 'r'
      `;
      const rlsMap: Record<string, boolean> = {};
      for (const r of rows as any[]) rlsMap[r.relname] = r.relrowsecurity;

      assert('all 10 tables found in pg_class', (rows as any[]).length === 10);
      for (const t of TABLES) {
        assert(`RLS enabled on "${t}"`, rlsMap[t] === true);
      }
    }

    // ── AC2: each table has the correct policy ─────────────────────────────────
    console.log('\nAC2 — Each table has the correct account isolation policy');
    {
      const rows = await (prisma as any).$queryRaw`
        SELECT tablename, policyname, qual
        FROM pg_policies
        WHERE tablename = ANY(ARRAY[
          'accounts','properties','bookings','messages','cleaners',
          'property_cleaners','turnover_checklists','cleaning_jobs',
          'work_orders','review_drafts'
        ])
      `;
      const policyMap: Record<string, { name: string; qual: string }> = {};
      for (const r of rows as any[]) {
        policyMap[r.tablename] = { name: r.policyname, qual: r.qual };
      }

      assert('all 10 tables have a policy', (rows as any[]).length >= 10);

      // accounts uses id = auth.uid()::text
      assert(
        'accounts policy is "accounts_isolation"',
        policyMap['accounts']?.name === 'accounts_isolation',
      );
      assert(
        'accounts policy uses id = auth.uid()::text',
        /\bid\s*=\s*\(auth\.uid\(\).*text\)/i.test(policyMap['accounts']?.qual ?? ''),
      );

      // all other tables use account_id = auth.uid()::text
      for (const t of TABLES.filter(x => x !== 'accounts')) {
        const expectedName = `${t}_account_isolation`;
        assert(
          `"${t}" policy is "${expectedName}"`,
          policyMap[t]?.name === expectedName,
        );
        assert(
          `"${t}" policy uses account_id = auth.uid()::text`,
          /account_id\s*=\s*\(auth\.uid\(\).*text\)/i.test(policyMap[t]?.qual ?? ''),
        );
      }
    }

    // ── AC3: 0 rows returned without valid auth context ────────────────────────
    // Uses pg client directly so we can SET LOCAL ROLE authenticated within
    // a single transaction (auth.uid() returns NULL → all rows filtered).
    console.log('\nAC3 — Queries without auth context return 0 rows');
    {
      const pgClient = new Client({
        connectionString: process.env.DIRECT_DATABASE_URL,
      });
      await pgClient.connect();

      // Seed a row so the table is non-empty (postgres role bypasses RLS)
      const seedRes = await pgClient.query(`
        INSERT INTO accounts (id, business_name, manager_phone, manager_email,
          alert_channel, communication_tone, password_hash)
        VALUES (gen_random_uuid()::text, 'RLS Test Co', '+15550012000',
          'rls@t012.test', 'sms', 'casual', 'hash')
        RETURNING id
      `);
      const testId = seedRes.rows[0].id;

      try {
        // Verify row exists as postgres superuser
        const superRes = await pgClient.query(
          `SELECT count(*) as cnt FROM accounts WHERE id = $1`, [testId]
        );
        assert('seed row visible to postgres superuser', superRes.rows[0].cnt === '1');

        // Switch to authenticated role (no JWT → auth.uid() returns NULL)
        await pgClient.query('BEGIN');
        await pgClient.query('SET LOCAL ROLE authenticated');

        // Sample 3 tables
        for (const table of ['accounts', 'properties', 'bookings']) {
          const res = await pgClient.query(`SELECT count(*) as cnt FROM ${table}`);
          assert(
            `"${table}": 0 rows returned as authenticated without JWT`,
            res.rows[0].cnt === '0',
          );
        }

        await pgClient.query('ROLLBACK');
      } finally {
        // Cleanup: delete seed row as superuser (outside the rolled-back txn)
        await pgClient.query(`DELETE FROM accounts WHERE id = $1`, [testId]);
        await pgClient.end();
      }
    }

    // ── AC4: migration file documents all SQL ──────────────────────────────────
    console.log('\nAC4 — Migration file documents all RLS SQL');
    {
      const migrDir = path.join(backendRoot, 'prisma', 'migrations');
      const migr = fs.readdirSync(migrDir).find(d => d.endsWith('_rls_policies'));
      assert('*_rls_policies migration folder exists', !!migr);

      if (migr) {
        const sql = fs.readFileSync(path.join(migrDir, migr, 'migration.sql'), 'utf8');

        // Every table should appear in ENABLE ROW LEVEL SECURITY
        for (const t of TABLES) {
          assert(
            `SQL enables RLS on "${t}"`,
            new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).test(sql),
          );
        }

        // accounts uses id = auth.uid()
        assert(
          'SQL has accounts_isolation policy',
          /CREATE POLICY accounts_isolation ON accounts/.test(sql),
        );
        assert(
          'accounts policy uses id = auth.uid()',
          /id = auth\.uid\(\)/.test(sql),
        );

        // other tables use account_id = auth.uid()
        for (const t of TABLES.filter(x => x !== 'accounts')) {
          assert(
            `SQL has ${t}_account_isolation policy`,
            new RegExp(`CREATE POLICY ${t}_account_isolation ON ${t}`).test(sql),
          );
        }

        assert(
          'policies use auth.uid()::text cast',
          /auth\.uid\(\)::text/.test(sql),
        );
      }

      const applied = await (prisma as any).$queryRaw`
        SELECT migration_name FROM "_prisma_migrations"
        WHERE migration_name = '20260418000008_rls_policies'
      `;
      assert('migration recorded in _prisma_migrations', (applied as any[]).length === 1);
    }

  } catch (e: unknown) {
    console.error('  ERROR', e instanceof Error ? e.message : e);
    assert('verification completed without errors', false);
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
