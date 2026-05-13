/**
 * T-025 — Booking Activation Sweep tests
 *
 * AC1: boss.work("booking-activation-sweep") registered in worker.ts
 * AC2: Bookings with checkin_datetime <= now() and status = 'upcoming' -> updated to 'active'
 * AC3: Atomic update: 0 rows affected -> skip (no double activation)
 * AC4: properties.property_status set to 'occupied' for each activated booking's property
 * AC5: Each activation logged with booking_id and property_id
 */

import { bookingActivationSweepHandler, _hooks } from './bookingActivation';

// ── Prisma mock ──────────────────────────────────────────────────────────────

const mockFindMany   = jest.fn();
const mockTransaction = jest.fn();
const mockExecuteRaw  = jest.fn();
const mockPropertyUpdate = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    bookings: {
      findMany: (...args: any[]) => mockFindMany(...args),
    },
    properties: {
      update: (...args: any[]) => mockPropertyUpdate(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
    $executeRaw:  (...args: any[]) => mockExecuteRaw(...args),
  },
}));

// ── Logger mock ──────────────────────────────────────────────────────────────

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logger from '../lib/logger';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const candidateBookings = [
  { id: 'BK-001', property_id: 'PROP-1' },
  { id: 'BK-002', property_id: 'PROP-2' },
];

// ── Reset ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.atomicActivate = undefined;
});

// ── AC1: boss.work registration ──────────────────────────────────────────────

describe('AC1 — booking-activation-sweep registered in worker.ts', () => {
  it('worker.ts imports and registers bookingActivationSweepHandler', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, '../worker.ts'), 'utf8');
    expect(src).toMatch(/booking-activation-sweep/);
    expect(src).toMatch(/bookingActivationSweepHandler/);
    expect(src).toMatch(/'booking-activation-sweep'\s*:\s*bookingActivationSweepHandler/);
  });
});

// ── AC2: Bookings with checkin_datetime <= now() and status = 'upcoming' activated ──

describe('AC2 — upcoming bookings with past checkin_datetime are activated', () => {
  it('queries for upcoming bookings with checkin_datetime <= now', async () => {
    const mockActivate = jest.fn().mockResolvedValue(true);
    _hooks.atomicActivate = mockActivate;
    mockFindMany.mockResolvedValue(candidateBookings);

    await bookingActivationSweepHandler();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status:           'upcoming',
          checkin_datetime: expect.objectContaining({ lte: expect.any(Date) }),
        }),
      }),
    );
  });

  it('calls atomicActivate for each candidate', async () => {
    const mockActivate = jest.fn().mockResolvedValue(true);
    _hooks.atomicActivate = mockActivate;
    mockFindMany.mockResolvedValue(candidateBookings);

    await bookingActivationSweepHandler();

    expect(mockActivate).toHaveBeenCalledTimes(2);
    expect(mockActivate).toHaveBeenCalledWith('BK-001', 'PROP-1');
    expect(mockActivate).toHaveBeenCalledWith('BK-002', 'PROP-2');
  });

  it('does nothing when no candidates exist', async () => {
    const mockActivate = jest.fn();
    _hooks.atomicActivate = mockActivate;
    mockFindMany.mockResolvedValue([]);

    await bookingActivationSweepHandler();

    expect(mockActivate).not.toHaveBeenCalled();
  });
});

// ── AC3: Atomic update — 0 rows affected → skip ──────────────────────────────

describe('AC3 — 0 rows affected → skip (no double activation)', () => {
  it('skips property update when atomicActivate returns false', async () => {
    _hooks.atomicActivate = jest.fn().mockResolvedValue(false);
    mockFindMany.mockResolvedValue([{ id: 'BK-001', property_id: 'PROP-1' }]);

    await bookingActivationSweepHandler();

    expect(mockPropertyUpdate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ booking_id: 'BK-001' }),
      expect.stringContaining('already active'),
    );
  });

  it('atomicActivateBooking source uses WHERE status = upcoming guard', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, './bookingActivation.ts'), 'utf8');
    // The SQL must include the conditional guard to prevent double-activation
    expect(src).toMatch(/AND\s+status\s*=\s*'upcoming'/);
  });

  it('processes remaining bookings even when one is skipped', async () => {
    const mockActivate = jest.fn()
      .mockResolvedValueOnce(false)   // BK-001 already activated
      .mockResolvedValueOnce(true);   // BK-002 activated now
    _hooks.atomicActivate = mockActivate;
    mockFindMany.mockResolvedValue(candidateBookings);

    await bookingActivationSweepHandler();

    expect(mockActivate).toHaveBeenCalledTimes(2);
  });
});

// ── AC4: property_status = 'occupied' set for each activated booking ──────────

describe('AC4 — property_status set to occupied for activated bookings', () => {
  it('atomicActivateBooking source updates property_status to occupied', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, './bookingActivation.ts'), 'utf8');
    expect(src).toMatch(/property_status.*occupied/);
    expect(src).toMatch(/\$transaction/);
  });

  it('property update is NOT called when activation returns false', async () => {
    _hooks.atomicActivate = jest.fn().mockResolvedValue(false);
    mockFindMany.mockResolvedValue([{ id: 'BK-001', property_id: 'PROP-1' }]);

    await bookingActivationSweepHandler();

    expect(mockPropertyUpdate).not.toHaveBeenCalled();
  });
});

// ── AC5: Each activation logged with booking_id and property_id ───────────────

describe('AC5 — each activation logged with booking_id and property_id', () => {
  it('logs booking_id and property_id when booking is activated', async () => {
    _hooks.atomicActivate = jest.fn().mockResolvedValue(true);
    mockFindMany.mockResolvedValue([{ id: 'BK-001', property_id: 'PROP-1' }]);

    await bookingActivationSweepHandler();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_id:   'BK-001',
        property_id:  'PROP-1',
        activated_at: expect.any(String),
      }),
      expect.stringContaining('booking activated'),
    );
  });

  it('logs booking_id when booking is skipped (already active)', async () => {
    _hooks.atomicActivate = jest.fn().mockResolvedValue(false);
    mockFindMany.mockResolvedValue([{ id: 'BK-001', property_id: 'PROP-1' }]);

    await bookingActivationSweepHandler();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ booking_id: 'BK-001' }),
      expect.any(String),
    );
  });

  it('logs all activated booking_ids when multiple bookings are activated', async () => {
    _hooks.atomicActivate = jest.fn().mockResolvedValue(true);
    mockFindMany.mockResolvedValue(candidateBookings);

    await bookingActivationSweepHandler();

    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const activationLogs = infoCalls.filter(([ctx]) =>
      ctx && ctx.booking_id && ctx.property_id,
    );
    expect(activationLogs).toHaveLength(2);
    expect(activationLogs[0][0]).toMatchObject({ booking_id: 'BK-001', property_id: 'PROP-1' });
    expect(activationLogs[1][0]).toMatchObject({ booking_id: 'BK-002', property_id: 'PROP-2' });
  });
});
