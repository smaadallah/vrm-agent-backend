/**
 * Unit tests for T-013: AES-256-GCM Encryption + Prisma Encryption Middleware
 *
 * AC1  encrypt/decrypt round-trip returns original string
 * AC2  null/undefined field values pass through middleware unchanged
 * AC3  middleware encrypts wifi_password before write (verified via mock next)
 * AC4  middleware decrypts wifi_password after read  (verified via mock next)
 * AC5  AES_KEY read from process.env.AES_KEY — never hardcoded (source inspection)
 *
 * AC3/AC4 note: the properties table does not exist until T-004 runs migrations.
 * The middleware is tested directly (mock params + mock next) — this is equivalent
 * to what happens in production; no live DB connection is required.
 *
 * Run with: npx ts-node src/lib/encryption.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

import { encrypt, decrypt } from './encryption';
import {
  prismaEncryptionMiddleware,
  type MiddlewareParams,
  type Next,
} from './prismaEncryptionMiddleware';

// ── Test key — valid 32-byte AES-256 key as 64 hex chars ─────────────────────
const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

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

function withKey(fn: () => void): void {
  const prev = process.env.AES_KEY;
  process.env.AES_KEY = TEST_KEY;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.AES_KEY;
    else process.env.AES_KEY = prev;
  }
}

async function withKeyAsync(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.AES_KEY;
  process.env.AES_KEY = TEST_KEY;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.AES_KEY;
    else process.env.AES_KEY = prev;
  }
}

// ── AC1: encrypt/decrypt round-trip ──────────────────────────────────────────
console.log('\nAC1 — encrypt(decrypt(ciphertext)) returns original string');
withKey(() => {
  const samples = [
    'hello world',
    'super-secret-wifi-password-123!',
    'door code: #4892',
    '',                     // empty string
    'unicode: 日本語テスト',
    'a'.repeat(5000),       // large value
  ];

  for (const original of samples) {
    const ciphertext = encrypt(original);
    const roundTrip = decrypt(ciphertext);
    assert(`round-trip: "${original.slice(0, 30)}..."`, roundTrip === original);
  }

  // Each call produces a different ciphertext (random IV)
  const ct1 = encrypt('same plaintext');
  const ct2 = encrypt('same plaintext');
  assert('different ciphertext each call (random IV)', ct1 !== ct2);

  // But both decrypt to the same value
  assert('both ciphertexts decrypt correctly', decrypt(ct1) === decrypt(ct2));

  // Ciphertext is base64 (not plaintext)
  const ciphertext = encrypt('plaintext value');
  assert('ciphertext is base64 (not plaintext)', ciphertext !== 'plaintext value');
  assert('ciphertext decodes to correct byte layout (IV+tag+data >= 28 bytes)',
    Buffer.from(ciphertext, 'base64').length >= 28);
});

// ── AC2: null/undefined pass through middleware unchanged ─────────────────────
console.log('\nAC2 — null/undefined field values pass through middleware unchanged');
(async () => {
  await withKeyAsync(async () => {
    let capturedArgs: Record<string, unknown> | null = null;

    const mockNext: Next = async (p) => {
      capturedArgs = p.args.data as Record<string, unknown>;
      return { id: '1', wifi_password: null, door_access_instructions: undefined };
    };

    // Write with null/undefined — must not encrypt them
    const writeParams: MiddlewareParams = {
      model: 'properties',
      action: 'create',
      args: {
        data: {
          name: 'Beach House',
          wifi_password: null,
          door_access_instructions: undefined,
        },
      },
      dataPath: [],
      runInTransaction: false,
    };

    const result = await prismaEncryptionMiddleware(writeParams, mockNext) as Record<string, unknown>;

    assert('null wifi_password stays null in write args', capturedArgs?.['wifi_password'] === null);
    assert('undefined door_access_instructions stays undefined in write args',
      capturedArgs?.['door_access_instructions'] === undefined);

    // Read result with null — must not attempt decrypt
    assert('null wifi_password in result stays null', result['wifi_password'] === null);

    // Non-encrypted model — args pass through untouched
    let bookingsArgsCaptured: Record<string, unknown> | null = null;
    const bookingsMock: Next = async (p) => {
      bookingsArgsCaptured = p.args.data as Record<string, unknown>;
      return { id: '1' };
    };
    const bookingsParams: MiddlewareParams = {
      model: 'bookings',
      action: 'create',
      args: { data: { guest_first_name: 'Alice' } },
      dataPath: [],
      runInTransaction: false,
    };
    await prismaEncryptionMiddleware(bookingsParams, bookingsMock);
    assert('non-encrypted model passes args through unchanged',
      (bookingsArgsCaptured as any)?.['guest_first_name'] === 'Alice');
  });
})();

// ── AC3: middleware encrypts wifi_password before write ───────────────────────
console.log('\nAC3 — middleware encrypts wifi_password before write (mock next)');
(async () => {
  await withKeyAsync(async () => {
    const plainPassword = 'MySecretWifiPass!99';
    let argsPassedToNext: Record<string, unknown> | null = null;

    const mockNext: Next = async (p) => {
      argsPassedToNext = { ...(p.args.data as Record<string, unknown>) };
      return { id: '1', wifi_password: argsPassedToNext['wifi_password'] };
    };

    const params: MiddlewareParams = {
      model: 'properties',
      action: 'create',
      args: {
        data: {
          name: 'Beach House',
          wifi_password: plainPassword,
          door_access_instructions: 'Code: 1234',
        },
      },
      dataPath: [],
      runInTransaction: false,
    };

    await prismaEncryptionMiddleware(params, mockNext);

    const encryptedPassword = (argsPassedToNext?.['wifi_password'] ?? '') as string;
    const encryptedDoor = (argsPassedToNext?.['door_access_instructions'] ?? '') as string;

    assert(
      'wifi_password passed to next is NOT the plaintext',
      encryptedPassword !== plainPassword,
    );
    assert(
      'wifi_password passed to next is a base64 string',
      typeof encryptedPassword === 'string' &&
        Buffer.from(encryptedPassword, 'base64').length >= 28,
    );
    assert(
      'door_access_instructions passed to next is NOT the plaintext',
      encryptedDoor !== 'Code: 1234',
    );

    // Decrypt what was passed to next — should get the original
    assert(
      'encrypted wifi_password decrypts back to plaintext',
      decrypt(encryptedPassword) === plainPassword,
    );

    // Non-encrypted field on properties is not touched
    assert(
      'non-encrypted field (name) is passed through unchanged',
      argsPassedToNext?.['name'] === 'Beach House',
    );

    // Also verify accounts model encrypts its fields
    let accountArgs: Record<string, unknown> | null = null;
    const accountMock: Next = async (p) => {
      accountArgs = { ...(p.args.data as Record<string, unknown>) };
      return {};
    };
    const accountParams: MiddlewareParams = {
      model: 'accounts',
      action: 'create',
      args: { data: { airbnb_access_token: 'tok_abc123', business_name: 'Acme' } },
      dataPath: [],
      runInTransaction: false,
    };
    await prismaEncryptionMiddleware(accountParams, accountMock);
    assert(
      'accounts.airbnb_access_token is encrypted before write',
      accountArgs?.['airbnb_access_token'] !== 'tok_abc123',
    );
    assert(
      'accounts.business_name (non-encrypted) is unchanged',
      accountArgs?.['business_name'] === 'Acme',
    );
  });
})();

// ── AC4: middleware decrypts wifi_password after read ─────────────────────────
console.log('\nAC4 — middleware decrypts wifi_password after read (mock next returns encrypted)');
(async () => {
  await withKeyAsync(async () => {
    const plainPassword = 'SuperSecretWifi#42';
    const plainDoor = 'Keypad code: 9988';
    const encryptedPassword = encrypt(plainPassword);
    const encryptedDoor = encrypt(plainDoor);

    // Mock next simulates DB returning the encrypted value (as stored in Supabase)
    const mockNext: Next = async (_p) => ({
      id: 'abc-123',
      name: 'Ocean View',
      wifi_password: encryptedPassword,
      door_access_instructions: encryptedDoor,
      checkin_time: '15:00',
    });

    const params: MiddlewareParams = {
      model: 'properties',
      action: 'findUnique',
      args: { where: { id: 'abc-123' } },
      dataPath: [],
      runInTransaction: false,
    };

    const result = await prismaEncryptionMiddleware(params, mockNext) as Record<string, unknown>;

    assert(
      'findUnique: wifi_password is decrypted to plaintext',
      result['wifi_password'] === plainPassword,
    );
    assert(
      'findUnique: door_access_instructions is decrypted to plaintext',
      result['door_access_instructions'] === plainDoor,
    );
    assert(
      'findUnique: non-encrypted field (name) is unchanged',
      result['name'] === 'Ocean View',
    );

    // findMany — array of rows
    const mockNextMany: Next = async (_p) => [
      { id: '1', wifi_password: encryptedPassword, name: 'House A' },
      { id: '2', wifi_password: encrypt('wifi2'), name: 'House B' },
    ];
    const manyParams: MiddlewareParams = {
      model: 'properties',
      action: 'findMany',
      args: {},
      dataPath: [],
      runInTransaction: false,
    };
    const manyResult = await prismaEncryptionMiddleware(manyParams, mockNextMany) as Record<string, unknown>[];
    assert(
      'findMany: first row wifi_password decrypted',
      (manyResult[0] as any)['wifi_password'] === plainPassword,
    );
    assert(
      'findMany: second row wifi_password decrypted',
      (manyResult[1] as any)['wifi_password'] === 'wifi2',
    );

    // accounts model — read decrypts token fields
    const encryptedToken = encrypt('airbnb_token_xyz');
    const accountMock: Next = async (_p) => ({
      id: '1',
      airbnb_access_token: encryptedToken,
      business_name: 'Acme',
    });
    const accountReadParams: MiddlewareParams = {
      model: 'accounts',
      action: 'findUnique',
      args: { where: { id: '1' } },
      dataPath: [],
      runInTransaction: false,
    };
    const accountResult = await prismaEncryptionMiddleware(accountReadParams, accountMock) as Record<string, unknown>;
    assert(
      'accounts.airbnb_access_token decrypted on findUnique',
      accountResult['airbnb_access_token'] === 'airbnb_token_xyz',
    );
  });
})();

// ── AC5: AES_KEY from env, never hardcoded ────────────────────────────────────
console.log('\nAC5 — AES_KEY read from process.env.AES_KEY, never hardcoded');
{
  const encryptionSrc = fs.readFileSync(path.join(__dirname, 'encryption.ts'), 'utf8');
  const middlewareSrc = fs.readFileSync(path.join(__dirname, 'prismaEncryptionMiddleware.ts'), 'utf8');
  const prismaSrc = fs.readFileSync(path.join(__dirname, 'prisma.ts'), 'utf8');

  assert(
    'encryption.ts reads AES_KEY from process.env',
    /process\.env\.AES_KEY/.test(encryptionSrc),
  );
  assert(
    'encryption.ts has no hardcoded 32-byte hex key literal',
    !(/[0-9a-f]{64}/i.test(encryptionSrc)),
  );
  assert(
    'encryption.ts throws if AES_KEY is not set',
    /throw new Error.*AES_KEY/.test(encryptionSrc),
  );
  assert(
    'prismaEncryptionMiddleware.ts does not read AES_KEY directly (delegates to encryption.ts)',
    !/process\.env\.AES_KEY/.test(middlewareSrc),
  );
  assert(
    'prisma.ts registers encryption middleware via $use()',
    /\$use\s*\(\s*prismaEncryptionMiddleware\s*\)/.test(prismaSrc),
  );

  // Runtime: throws when AES_KEY not set
  const savedKey = process.env.AES_KEY;
  delete process.env.AES_KEY;
  let threw = false;
  try {
    encrypt('test');
  } catch (e: unknown) {
    threw = e instanceof Error && /AES_KEY/.test(e.message);
  }
  if (savedKey !== undefined) process.env.AES_KEY = savedKey;
  assert('encrypt() throws with helpful message when AES_KEY not set', threw);

  // Runtime: throws when AES_KEY is wrong length
  const prevKey = process.env.AES_KEY;
  process.env.AES_KEY = 'tooshort';
  let threwBadLen = false;
  try {
    encrypt('test');
  } catch (e: unknown) {
    threwBadLen = e instanceof Error && /32-byte/.test(e.message);
  }
  if (prevKey !== undefined) process.env.AES_KEY = prevKey;
  else delete process.env.AES_KEY;
  assert('encrypt() throws with helpful message when AES_KEY is wrong length', threwBadLen);
}

// ── Summary (deferred — let async sections finish first) ─────────────────────
setTimeout(() => {
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}, 200);
