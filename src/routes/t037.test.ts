/**
 * T-037 verification — GET /api/account + PATCH /api/settings + GET /api/search
 *
 * AC1  GET /api/account returns account data with OAuth connection state booleans.
 * AC2  PATCH /api/settings updates allowed fields; E.164 re-validation on manager_phone.
 * AC3  disconnect_airbnb clears both OAuth tokens and increments token_version.
 * AC4  GET /api/search?q= returns matching bookings and properties for authenticated account only.
 * AC5  q > 100 chars -> 400.
 * AC6  Search results include type, id, display_name, url.
 *
 * Run: npx ts-node src/routes/t037.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

process.env.JWT_SECRET = 'test-secret-t037';
process.env.PORT = '0';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { accountRouter, settingsRouter } from './settings';
import searchRouter from './search';

// ── Minimal test app ──────────────────────────────────────────────────────────
const testApp = express();
testApp.use(express.json());
testApp.use('/api/account',  accountRouter);
testApp.use('/api/settings', settingsRouter);
testApp.use('/api/search',   searchRouter);
testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

// ── Constants ─────────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-secret-t037';
const ACCOUNT_ID = 'acc-t037-001';

function makeToken(accountId = ACCOUNT_ID, tokenVersion = 1): string {
  return jwt.sign({ accountId, tokenVersion }, JWT_SECRET);
}

function fakeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id:                        ACCOUNT_ID,
    business_name:             'Beach Stay Co',
    manager_phone:             '+13055550001',
    manager_email:             'manager@example.com',
    alert_channel:             'sms',
    communication_tone:        'casual',
    twilio_phone_number:       null,
    airbnb_access_token:       'airbnb-token-xyz',
    airbnb_refresh_token:      'airbnb-refresh-xyz',
    vrbo_access_token:         null,
    vrbo_refresh_token:        null,
    token_version:             1,
    daily_ai_token_usage:      0,
    ai_token_daily_cap:        500000,
    ai_token_cap_reset_at:     null,
    data_region:               'us',
    password_hash:             'hashed-password',
    password_reset_token:      null,
    password_reset_expires_at: null,
    created_at:                new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// Stubs prisma.accounts.findUnique for auth middleware + account route handler
function stubAccountFU(returnValue: unknown): () => void {
  const orig = (prisma.accounts as any).findUnique;
  (prisma.accounts as any).findUnique = async () => returnValue;
  return () => { (prisma.accounts as any).findUnique = orig; };
}

// ── Assertion helpers ─────────────────────────────────────────────────────────
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

// ── Tests ─────────────────────────────────────────────────────────────────────
(async () => {

  // ════════════════════════════════════════════════════════════════════════════
  // AC1 — GET /api/account returns account data with OAuth connection state booleans
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC1a — GET /api/account returns safe fields and OAuth booleans');
  {
    const restore = stubAccountFU(fakeAccount());

    const res = await request(testApp)
      .get('/api/account')
      .set('Authorization', `Bearer ${makeToken()}`);

    restore();

    assert('AC1a: status 200',                    res.status === 200);
    assert('AC1a: data.id present',               res.body?.data?.id === ACCOUNT_ID);
    assert('AC1a: data.business_name present',    res.body?.data?.business_name === 'Beach Stay Co');
    assert('AC1a: data.alert_channel present',    res.body?.data?.alert_channel === 'sms');
    assert('AC1a: airbnb_connected true (token present)',
      res.body?.data?.airbnb_connected === true);
    assert('AC1a: vrbo_connected false (token null)',
      res.body?.data?.vrbo_connected === false);
    // Sensitive fields must NOT appear
    assert('AC1a: password_hash omitted',          res.body?.data?.password_hash === undefined);
    assert('AC1a: airbnb_access_token omitted',    res.body?.data?.airbnb_access_token === undefined);
    assert('AC1a: airbnb_refresh_token omitted',   res.body?.data?.airbnb_refresh_token === undefined);
    assert('AC1a: vrbo_access_token omitted',      res.body?.data?.vrbo_access_token === undefined);
    assert('AC1a: vrbo_refresh_token omitted',     res.body?.data?.vrbo_refresh_token === undefined);
    assert('AC1a: password_reset_token omitted',   res.body?.data?.password_reset_token === undefined);
  }

  console.log('\nAC1b — airbnb_connected reflects token presence');
  {
    const restore = stubAccountFU(fakeAccount({ airbnb_access_token: null }));

    const res = await request(testApp)
      .get('/api/account')
      .set('Authorization', `Bearer ${makeToken()}`);

    restore();

    assert('AC1b: airbnb_connected false when token null', res.body?.data?.airbnb_connected === false);
    assert('AC1b: vrbo_connected false when token null',   res.body?.data?.vrbo_connected   === false);
  }

  console.log('\nAC1c — vrbo_connected true when vrbo_access_token present');
  {
    const restore = stubAccountFU(fakeAccount({ vrbo_access_token: 'vrbo-tok', airbnb_access_token: null }));

    const res = await request(testApp)
      .get('/api/account')
      .set('Authorization', `Bearer ${makeToken()}`);

    restore();

    assert('AC1c: vrbo_connected true',   res.body?.data?.vrbo_connected   === true);
    assert('AC1c: airbnb_connected false', res.body?.data?.airbnb_connected === false);
  }

  console.log('\nAC1d — GET /api/account without token -> 401');
  {
    const res = await request(testApp).get('/api/account');
    assert('AC1d: 401 without token', res.status === 401);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC2 — PATCH /api/settings updates allowed fields; E.164 on manager_phone
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC2a — PATCH updates allowed scalar fields');
  {
    const restore = stubAccountFU(fakeAccount());
    const origUpdate = (prisma.accounts as any).update;
    let capturedArgs: any = null;
    (prisma.accounts as any).update = async (args: any) => {
      capturedArgs = args;
      return fakeAccount({ business_name: 'New Name', alert_channel: 'email', communication_tone: 'luxury' });
    };

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ business_name: 'New Name', alert_channel: 'email', communication_tone: 'luxury' });

    (prisma.accounts as any).update = origUpdate;
    restore();

    assert('AC2a: status 200',                        res.status === 200);
    assert('AC2a: update called',                     capturedArgs !== null);
    assert('AC2a: business_name in update data',      capturedArgs?.data?.business_name === 'New Name');
    assert('AC2a: alert_channel in update data',      capturedArgs?.data?.alert_channel === 'email');
    assert('AC2a: communication_tone in update data', capturedArgs?.data?.communication_tone === 'luxury');
    assert('AC2a: where.id = JWT accountId',          capturedArgs?.where?.id === ACCOUNT_ID);
  }

  console.log('\nAC2b — PATCH valid E.164 manager_phone accepted');
  {
    const restore = stubAccountFU(fakeAccount());
    const origUpdate = (prisma.accounts as any).update;
    let capturedArgs: any = null;
    (prisma.accounts as any).update = async (args: any) => { capturedArgs = args; return fakeAccount({ manager_phone: '+447911123456' }); };

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ manager_phone: '+447911123456' });

    (prisma.accounts as any).update = origUpdate;
    restore();

    assert('AC2b: 200 for valid E.164 phone',       res.status === 200);
    assert('AC2b: manager_phone stored',             capturedArgs?.data?.manager_phone === '+447911123456');
  }

  console.log('\nAC2c — PATCH invalid manager_phone -> 400');
  {
    const restore = stubAccountFU(fakeAccount());
    const origUpdate = (prisma.accounts as any).update;
    let updateCalled = false;
    (prisma.accounts as any).update = async () => { updateCalled = true; return fakeAccount(); };

    const invalidPhones = ['3055550001', '+0123456', 'not-a-phone', '+1', ''];
    for (const phone of invalidPhones) {
      const res = await request(testApp)
        .patch('/api/settings')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ manager_phone: phone });

      assert(`AC2c: 400 for invalid phone "${phone}"`, res.status === 400);
      assert(`AC2c: error mentions E.164 for "${phone}"`, /E\.164|format/i.test(res.body?.error ?? ''));
    }
    assert('AC2c: DB update not called for invalid phone', updateCalled === false);

    (prisma.accounts as any).update = origUpdate;
    restore();
  }

  console.log('\nAC2d — PATCH rejects invalid alert_channel');
  {
    const restore = stubAccountFU(fakeAccount());

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ alert_channel: 'telegram' });

    restore();
    assert('AC2d: 400 for invalid alert_channel', res.status === 400);
  }

  console.log('\nAC2e — PATCH rejects invalid communication_tone');
  {
    const restore = stubAccountFU(fakeAccount());

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ communication_tone: 'aggressive' });

    restore();
    assert('AC2e: 400 for invalid communication_tone', res.status === 400);
  }

  console.log('\nAC2f — PATCH with no recognized fields returns { updated: false }');
  {
    const restore = stubAccountFU(fakeAccount());
    const origUpdate = (prisma.accounts as any).update;
    let updateCalled = false;
    (prisma.accounts as any).update = async () => { updateCalled = true; return fakeAccount(); };

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ unknown_field: 'ignored' });

    (prisma.accounts as any).update = origUpdate;
    restore();

    assert('AC2f: 200 with no-op body',          res.status === 200);
    assert('AC2f: update not called',             updateCalled === false);
    assert('AC2f: data.updated = false',          res.body?.data?.updated === false);
  }

  console.log('\nAC2g — response strips sensitive fields after update');
  {
    const restore = stubAccountFU(fakeAccount());
    const origUpdate = (prisma.accounts as any).update;
    (prisma.accounts as any).update = async () => fakeAccount({ business_name: 'Updated Co' });

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ business_name: 'Updated Co' });

    (prisma.accounts as any).update = origUpdate;
    restore();

    assert('AC2g: password_hash not in response',          res.body?.data?.password_hash === undefined);
    assert('AC2g: airbnb_access_token not in response',    res.body?.data?.airbnb_access_token === undefined);
    assert('AC2g: response has airbnb_connected boolean',  typeof res.body?.data?.airbnb_connected === 'boolean');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC3 — disconnect_airbnb clears both OAuth tokens and increments token_version
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC3a — disconnect_airbnb clears tokens and increments token_version');
  {
    const restore = stubAccountFU(fakeAccount());
    const origUpdate = (prisma.accounts as any).update;
    let capturedArgs: any = null;
    (prisma.accounts as any).update = async (args: any) => {
      capturedArgs = args;
      return fakeAccount({ airbnb_access_token: null, airbnb_refresh_token: null, token_version: 2 });
    };

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ disconnect_airbnb: true });

    (prisma.accounts as any).update = origUpdate;
    restore();

    assert('AC3a: status 200',                          res.status === 200);
    assert('AC3a: airbnb_access_token set to null',     capturedArgs?.data?.airbnb_access_token  === null);
    assert('AC3a: airbnb_refresh_token set to null',    capturedArgs?.data?.airbnb_refresh_token === null);
    assert('AC3a: token_version increment present',
      capturedArgs?.data?.token_version?.increment >= 1);
    assert('AC3a: vrbo tokens not touched',
      capturedArgs?.data?.vrbo_access_token  === undefined &&
      capturedArgs?.data?.vrbo_refresh_token === undefined);
    assert('AC3a: airbnb_connected false in response',  res.body?.data?.airbnb_connected === false);
  }

  console.log('\nAC3b — disconnect_vrbo clears vrbo tokens and increments token_version');
  {
    const restore = stubAccountFU(fakeAccount({ vrbo_access_token: 'v-tok', vrbo_refresh_token: 'v-ref' }));
    const origUpdate = (prisma.accounts as any).update;
    let capturedArgs: any = null;
    (prisma.accounts as any).update = async (args: any) => {
      capturedArgs = args;
      return fakeAccount({ vrbo_access_token: null, vrbo_refresh_token: null, token_version: 2 });
    };

    const res = await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ disconnect_vrbo: true });

    (prisma.accounts as any).update = origUpdate;
    restore();

    assert('AC3b: vrbo_access_token set to null',    capturedArgs?.data?.vrbo_access_token  === null);
    assert('AC3b: vrbo_refresh_token set to null',   capturedArgs?.data?.vrbo_refresh_token === null);
    assert('AC3b: token_version increment >= 1',     capturedArgs?.data?.token_version?.increment >= 1);
    assert('AC3b: airbnb tokens not touched',
      capturedArgs?.data?.airbnb_access_token  === undefined &&
      capturedArgs?.data?.airbnb_refresh_token === undefined);
    assert('AC3b: vrbo_connected false in response', res.body?.data?.vrbo_connected === false);
  }

  console.log('\nAC3c — disconnect both platforms increments token_version by 2');
  {
    const restore = stubAccountFU(fakeAccount({ vrbo_access_token: 'v-tok', vrbo_refresh_token: 'v-ref' }));
    const origUpdate = (prisma.accounts as any).update;
    let capturedArgs: any = null;
    (prisma.accounts as any).update = async (args: any) => {
      capturedArgs = args;
      return fakeAccount({ airbnb_access_token: null, airbnb_refresh_token: null, vrbo_access_token: null, vrbo_refresh_token: null, token_version: 3 });
    };

    await request(testApp)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ disconnect_airbnb: true, disconnect_vrbo: true });

    (prisma.accounts as any).update = origUpdate;
    restore();

    assert('AC3c: token_version incremented by 2',   capturedArgs?.data?.token_version?.increment === 2);
    assert('AC3c: all 4 OAuth tokens set to null',
      capturedArgs?.data?.airbnb_access_token  === null &&
      capturedArgs?.data?.airbnb_refresh_token === null &&
      capturedArgs?.data?.vrbo_access_token    === null &&
      capturedArgs?.data?.vrbo_refresh_token   === null);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC4 — GET /api/search?q= returns matches for authenticated account only
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC4a — search returns matching bookings and properties');
  {
    const restore = stubAccountFU(fakeAccount());

    const origBookingsFM  = (prisma.bookings   as any).findMany;
    const origPropertiesFM = (prisma.properties as any).findMany;

    let capturedBookingsWhere: any   = null;
    let capturedPropertiesWhere: any = null;

    (prisma.bookings as any).findMany = async (args: any) => {
      capturedBookingsWhere = args.where;
      return [
        { id: 'booking-001', guest_first_name: 'Maria', guest_last_name: 'Lopez', property_id: 'prop-001' },
      ];
    };
    (prisma.properties as any).findMany = async (args: any) => {
      capturedPropertiesWhere = args.where;
      return [
        { id: 'prop-001', name: 'Beach House' },
      ];
    };

    const res = await request(testApp)
      .get('/api/search?q=beach')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings   as any).findMany = origBookingsFM;
    (prisma.properties as any).findMany = origPropertiesFM;
    restore();

    assert('AC4a: status 200',                            res.status === 200);
    assert('AC4a: data is array',                         Array.isArray(res.body?.data));
    assert('AC4a: bookings query uses JWT account_id',    capturedBookingsWhere?.account_id   === ACCOUNT_ID);
    assert('AC4a: properties query uses JWT account_id',  capturedPropertiesWhere?.account_id === ACCOUNT_ID);
    assert('AC4a: booking result present',
      res.body?.data?.some((r: any) => r.type === 'booking'));
    assert('AC4a: property result present',
      res.body?.data?.some((r: any) => r.type === 'property'));
  }

  console.log('\nAC4b — search without q returns empty array');
  {
    const restore = stubAccountFU(fakeAccount());

    const res = await request(testApp)
      .get('/api/search')
      .set('Authorization', `Bearer ${makeToken()}`);

    restore();
    assert('AC4b: 200 with empty data', res.status === 200 && Array.isArray(res.body?.data) && res.body.data.length === 0);
  }

  console.log('\nAC4c — search without token -> 401');
  {
    const res = await request(testApp).get('/api/search?q=beach');
    assert('AC4c: 401 without token', res.status === 401);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC5 — q > 100 chars -> 400
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC5a — q exactly 100 chars -> 200 (boundary)');
  {
    const restore = stubAccountFU(fakeAccount());
    const origBFM = (prisma.bookings   as any).findMany;
    const origPFM = (prisma.properties as any).findMany;
    (prisma.bookings   as any).findMany = async () => [];
    (prisma.properties as any).findMany = async () => [];

    const q100 = 'a'.repeat(100);
    const res = await request(testApp)
      .get(`/api/search?q=${q100}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings   as any).findMany = origBFM;
    (prisma.properties as any).findMany = origPFM;
    restore();

    assert('AC5a: 200 for q=100 chars', res.status === 200);
  }

  console.log('\nAC5b — q = 101 chars -> 400');
  {
    const restore = stubAccountFU(fakeAccount());

    const q101 = 'a'.repeat(101);
    const res = await request(testApp)
      .get(`/api/search?q=${q101}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    restore();
    assert('AC5b: 400 for q=101 chars',        res.status === 400);
    assert('AC5b: error message present',       typeof res.body?.error === 'string');
    assert('AC5b: error mentions 100 chars',    /100/i.test(res.body?.error ?? ''));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AC6 — Search results include type, id, display_name, url
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nAC6a — booking result shape: type, id, display_name (full name), url (thread path)');
  {
    const restore = stubAccountFU(fakeAccount());
    const origBFM = (prisma.bookings   as any).findMany;
    const origPFM = (prisma.properties as any).findMany;

    (prisma.bookings as any).findMany = async () => [
      { id: 'bk-001', guest_first_name: 'John', guest_last_name: 'Smith', property_id: 'pr-001' },
    ];
    (prisma.properties as any).findMany = async () => [];

    const res = await request(testApp)
      .get('/api/search?q=john')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings   as any).findMany = origBFM;
    (prisma.properties as any).findMany = origPFM;
    restore();

    const result = res.body?.data?.[0];
    assert('AC6a: type = booking',              result?.type         === 'booking');
    assert('AC6a: id = booking id',             result?.id           === 'bk-001');
    assert('AC6a: display_name = full name',    result?.display_name === 'John Smith');
    assert('AC6a: url = thread path',           result?.url          === '/properties/pr-001/messages/bk-001');
  }

  console.log('\nAC6b — property result shape: type, id, display_name (name), url (/properties/:id)');
  {
    const restore = stubAccountFU(fakeAccount());
    const origBFM = (prisma.bookings   as any).findMany;
    const origPFM = (prisma.properties as any).findMany;

    (prisma.bookings   as any).findMany = async () => [];
    (prisma.properties as any).findMany = async () => [
      { id: 'pr-999', name: 'Ocean View Villa' },
    ];

    const res = await request(testApp)
      .get('/api/search?q=ocean')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings   as any).findMany = origBFM;
    (prisma.properties as any).findMany = origPFM;
    restore();

    const result = res.body?.data?.[0];
    assert('AC6b: type = property',             result?.type         === 'property');
    assert('AC6b: id = property id',            result?.id           === 'pr-999');
    assert('AC6b: display_name = property name', result?.display_name === 'Ocean View Villa');
    assert('AC6b: url = /properties/:id',        result?.url          === '/properties/pr-999');
  }

  console.log('\nAC6c — both bookings and properties returned in same response');
  {
    const restore = stubAccountFU(fakeAccount());
    const origBFM = (prisma.bookings   as any).findMany;
    const origPFM = (prisma.properties as any).findMany;

    (prisma.bookings   as any).findMany = async () => [
      { id: 'bk-A', guest_first_name: 'Ana', guest_last_name: 'Garcia', property_id: 'pr-A' },
    ];
    (prisma.properties as any).findMany = async () => [
      { id: 'pr-A', name: 'Ana House' },
    ];

    const res = await request(testApp)
      .get('/api/search?q=ana')
      .set('Authorization', `Bearer ${makeToken()}`);

    (prisma.bookings   as any).findMany = origBFM;
    (prisma.properties as any).findMany = origPFM;
    restore();

    assert('AC6c: 2 results total',     res.body?.data?.length === 2);
    assert('AC6c: has booking result',  res.body?.data?.some((r: any) => r.type === 'booking'));
    assert('AC6c: has property result', res.body?.data?.some((r: any) => r.type === 'property'));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Source-level checks
  // ════════════════════════════════════════════════════════════════════════════

  console.log('\nSource checks — verify file structure and index registration');
  {
    const settingsSrc = fs.readFileSync(path.join(__dirname, 'settings.ts'), 'utf8');
    const searchSrc   = fs.readFileSync(path.join(__dirname, 'search.ts'),   'utf8');
    const idxSrc      = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

    // settings.ts structure
    assert('src: accountRouter exported',           /export.*accountRouter/.test(settingsSrc));
    assert('src: settingsRouter exported',          /export.*settingsRouter/.test(settingsSrc));
    assert('src: GET / in accountRouter',           /accountRouter\.get\s*\(\s*['"]\/'/.test(settingsSrc));
    assert('src: PATCH / in settingsRouter',        /settingsRouter\.patch\s*\(\s*['"]\/'/.test(settingsSrc));
    assert('src: E164 regex in settings',           /\+\[1-9\]\\d\{1,14\}/.test(settingsSrc));
    assert('src: disconnect_airbnb handled',        /disconnect_airbnb/.test(settingsSrc));
    assert('src: disconnect_vrbo handled',          /disconnect_vrbo/.test(settingsSrc));
    assert('src: token_version increment',          /token_version.*increment/.test(settingsSrc));
    assert('src: password_hash stripped',           /password_hash/.test(settingsSrc));
    assert('src: airbnb_connected boolean',         /airbnb_connected/.test(settingsSrc));

    // search.ts structure
    assert('src: GET / in searchRouter',            /router\.get\s*\(\s*['"]\/'/.test(searchSrc));
    assert('src: q.length > 100 check',             /q\.length\s*>\s*100/.test(searchSrc));
    assert('src: guest_first_name search',          /guest_first_name/.test(searchSrc));
    assert('src: guest_last_name search',           /guest_last_name/.test(searchSrc));
    assert('src: platform_booking_id search',       /platform_booking_id/.test(searchSrc));
    assert('src: insensitive mode',                 /insensitive/.test(searchSrc));
    assert('src: type booking in map',              /type.*booking/.test(searchSrc));
    assert('src: type property in map',             /type.*property/.test(searchSrc));
    assert('src: display_name in result',           /display_name/.test(searchSrc));
    assert('src: url in result',                    /url:/.test(searchSrc));

    // index.ts registration
    assert('src: index imports accountRouter',      /accountRouter/.test(idxSrc));
    assert('src: index imports settingsRouter',     /settingsRouter/.test(idxSrc));
    assert('src: index mounts /api/account',
      /app\.use\(['"]\/api\/account['"].*accountRouter\)/.test(idxSrc));
    assert('src: index mounts /api/settings',
      /app\.use\(['"]\/api\/settings['"].*settingsRouter\)/.test(idxSrc));
    assert('src: index mounts /api/search',
      /app\.use\(['"]\/api\/search['"].*searchRouter\)/.test(idxSrc));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
