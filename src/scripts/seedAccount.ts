/**
 * Seed script — inserts a development/test account into the database.
 * Idempotent: skips insertion if the email already exists.
 *
 * Run with: npx ts-node src/scripts/seedAccount.ts
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
if (process.env.DIRECT_DATABASE_URL) process.env.DATABASE_URL = process.env.DIRECT_DATABASE_URL;

import bcrypt from 'bcrypt';
import { Client } from 'pg';

const SEED_EMAIL    = 'admin@vrm.dev';
const SEED_PASSWORD = 'VrmAdmin!2026';
const SEED_PHONE    = '+15550010001';
const SEED_NAME     = 'VRM Dev Account';

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Check if account already exists
    const existing = await client.query(
      `SELECT id, manager_email FROM accounts WHERE manager_email = $1`,
      [SEED_EMAIL],
    );

    if (existing.rows.length > 0) {
      console.log(`Account already exists — id: ${existing.rows[0].id}`);
      console.log(`Email   : ${SEED_EMAIL}`);
      console.log(`Password: ${SEED_PASSWORD}`);
      return;
    }

    const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

    const result = await client.query(`
      INSERT INTO accounts (
        id, business_name, manager_phone, manager_email,
        alert_channel, communication_tone, password_hash, token_version
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3,
        'sms', 'professional', $4, 1
      )
      RETURNING id, manager_email, business_name, created_at
    `, [SEED_NAME, SEED_PHONE, SEED_EMAIL, passwordHash]);

    const row = result.rows[0];
    console.log('Account seeded successfully:');
    console.log(`  id          : ${row.id}`);
    console.log(`  business    : ${row.business_name}`);
    console.log(`  email       : ${row.manager_email}`);
    console.log(`  password    : ${SEED_PASSWORD}`);
    console.log(`  created_at  : ${row.created_at}`);
  } finally {
    await client.end();
  }
})();
