/**
 * Verification script for T-002: Prisma + Supabase Database Connection Setup
 * Run with: npx ts-node src/lib/prisma.verify.ts
 *
 * Note on AC2/AC6: PrismaClient cannot be instantiated until models exist
 * (prisma generate requires at least one model — those land in T-003 onwards).
 * AC2 and AC6 are verified by source-code inspection of the singleton pattern,
 * which is the authoritative check for these structural criteria.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

const backendRoot = path.join(__dirname, '..', '..');
const schemaPath = path.join(backendRoot, 'prisma', 'schema.prisma');
const primsaSrc = fs.readFileSync(path.join(__dirname, 'prisma.ts'), 'utf8');
const envExamplePath = path.join(backendRoot, '.env.example');
const envExample = fs.readFileSync(envExamplePath, 'utf8');

// ── AC1: schema.prisma has datasource db with url and directUrl ──────────────
console.log('\nAC1 — schema.prisma has datasource db with url and directUrl');
{
  const schema = fs.readFileSync(schemaPath, 'utf8');

  assert('datasource db block exists', /datasource\s+db\s*\{/.test(schema));
  assert('provider = "postgresql"', /provider\s*=\s*"postgresql"/.test(schema));
  assert('url = env("DATABASE_URL")', /url\s*=\s*env\("DATABASE_URL"\)/.test(schema));
  assert('directUrl = env("DIRECT_DATABASE_URL")', /directUrl\s*=\s*env\("DIRECT_DATABASE_URL"\)/.test(schema));
}

// ── AC2: /backend/src/lib/prisma.ts exports a singleton PrismaClient ─────────
console.log('\nAC2 — prisma.ts exports a singleton PrismaClient (source inspection)');
{
  const prismaFile = path.join(__dirname, 'prisma.ts');
  assert('prisma.ts file exists', fs.existsSync(prismaFile));
  assert(
    "imports PrismaClient from '@prisma/client'",
    /from\s+['"]@prisma\/client['"]/.test(primsaSrc),
  );
  assert(
    'exports named const `prisma`',
    /export\s+const\s+prisma/.test(primsaSrc),
  );
  assert(
    'exports default',
    /export\s+default\s+prisma/.test(primsaSrc),
  );
  assert(
    'instantiates new PrismaClient()',
    /new\s+PrismaClient\(\)/.test(primsaSrc),
  );
}

// ── AC3: npx prisma validate passes without errors ───────────────────────────
console.log('\nAC3 — npx prisma validate passes without errors');
{
  try {
    const output = execSync('npx prisma validate', {
      cwd: backendRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert('prisma validate exits with code 0', true);
    assert('output confirms schema is valid', /is valid/.test(output));
  } catch (e: any) {
    const stderr: string = e.stderr ?? '';
    const stdout: string = e.stdout ?? '';
    console.error('  stderr:', stderr.trim().split('\n')[0]);
    assert('prisma validate exits with code 0', false);
    assert('output confirms schema is valid', false);
  }
}

// ── AC4: .env.example documents DATABASE_URL with ?connection_limit=1&pgbouncer=true ──
console.log('\nAC4 — .env.example documents DATABASE_URL with pooler format note');
{
  assert('DATABASE_URL entry present', /^DATABASE_URL/m.test(envExample));
  assert(
    'format note includes ?connection_limit=1',
    envExample.includes('connection_limit=1'),
  );
  assert(
    'format note includes &pgbouncer=true',
    envExample.includes('pgbouncer=true'),
  );
  assert(
    'format note references Session Mode or pooler',
    /session.mode|pooler/i.test(envExample),
  );
}

// ── AC5: .env.example documents DIRECT_DATABASE_URL ─────────────────────────
console.log('\nAC5 — .env.example documents DIRECT_DATABASE_URL');
{
  assert('DIRECT_DATABASE_URL entry present', /^DIRECT_DATABASE_URL/m.test(envExample));
  assert(
    'explains it is used for migrations',
    /migration/i.test(envExample),
  );
}

// ── AC6: No PrismaClient instantiated more than once per process ─────────────
console.log('\nAC6 — No PrismaClient instantiated more than once per process (source inspection)');
{
  // The globalThis guard ensures the same instance is reused across hot-reloads
  // in development, and Node module caching ensures it in production.
  assert(
    'globalThis singleton guard present',
    /globalThis|globalForPrisma/.test(primsaSrc),
  );
  assert(
    'singleton uses ?? (nullish coalesce) — creates instance only if absent',
    /\?\?\s*new\s+PrismaClient/.test(primsaSrc),
  );
  assert(
    'NODE_ENV !== production guard prevents re-assignment in prod',
    /NODE_ENV\s*!==?\s*['"]production['"]/.test(primsaSrc),
  );
  assert(
    'new PrismaClient() appears exactly once in source',
    (primsaSrc.match(/new\s+PrismaClient\(\)/g) ?? []).length === 1,
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
