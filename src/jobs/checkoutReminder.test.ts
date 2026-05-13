/**
 * T-029 — checkout-reminder-sweep tests
 *
 * AC1: boss.work("checkout-reminder-sweep") registered
 * AC2: Job skips processing entirely when ET is outside 19:30–21:00
 * AC3: Message sent only to active bookings with tomorrow's checkout date
 * AC4: checkout_reminder_enabled = false -> property skipped
 * AC5: Default template uses database values only
 * AC6: checkout_reminder_sent = true set on success
 * AC7: Missed send at 21:00 triggers manager alert
 */

import {
  checkoutReminderSweepHandler,
  buildCheckoutReminderMessage,
  getEasternMinutes,
  getTomorrowUTCBounds,
  _hooks,
} from './checkoutReminder';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const mockFindMany = jest.fn();
const mockUpdate   = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    bookings: {
      findMany: (...a: any[]) => mockFindMany(...a),
      update:   (...a: any[]) => mockUpdate(...a),
    },
  },
}));

// ── workOrderCreation mock ────────────────────────────────────────────────────

const mockSendPlatformMessage = jest.fn();
const mockSendManagerSms      = jest.fn();

jest.mock('./workOrderCreation', () => ({
  sendPlatformMessage: (...a: any[]) => mockSendPlatformMessage(...a),
  sendManagerSms:      (...a: any[]) => mockSendManagerSms(...a),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logger from '../lib/logger';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockAccount = {
  id:                  'ACC-1',
  business_name:       'Shoreside Stays',
  twilio_phone_number: '+15559990000',
  manager_phone:       '+15550001111',
  alert_channel:       'sms',
};

const mockProperty = {
  id:                          'PROP-1',
  account_id:                  'ACC-1',
  name:                        'Palm View Suite',
  checkout_time:               '11:00 AM',
  checkout_steps:              'Leave keys on counter. Lock the door.',
  checkout_reminder_enabled:   true,
  checkout_reminder_template:  null as string | null,
};

function mockBooking(overrides: Record<string, any> = {}) {
  return {
    id:                     'BK-1',
    account_id:             'ACC-1',
    property_id:            'PROP-1',
    guest_first_name:       'Sam',
    guest_last_name:        'Rivera',
    guest_platform_id:      'GUEST-1',
    platform:               'airbnb',
    checkout_reminder_sent: false,
    property:               { ...mockProperty },
    account:                { ...mockAccount },
    ...overrides,
  };
}

// ── Time helpers ──────────────────────────────────────────────────────────────

/**
 * Builds a UTC Date whose Eastern Time is the given hour:minute.
 * Uses a fixed summer date (UTC-4 / EDT) for predictable ET offsets.
 */
function etTime(hour: number, minute = 0): Date {
  // 2026-07-15 is a Wednesday in EDT (UTC-4).
  // To get ET hh:mm, we need UTC = ET + 4h.
  const utcHour = hour + 4;
  return new Date(Date.UTC(2026, 6, 15, utcHour, minute, 0, 0)); // month is 0-indexed
}

/**
 * Returns a checkout_datetime (UTC) that falls on "tomorrow" in ET
 * when "now" is etTime(20, 0) — i.e. July 16 in ET, 11:00 AM checkout.
 */
function tomorrowCheckout(): Date {
  // "now" = 2026-07-15 20:00 ET = 2026-07-16 00:00 UTC
  // "tomorrow in ET" = 2026-07-16 (ET date)
  // checkout_time = 11:00 AM ET = 15:00 UTC (EDT, UTC-4)
  return new Date(Date.UTC(2026, 6, 16, 15, 0, 0, 0));
}

/** Returns a checkout_datetime that is NOT tomorrow in ET (2 days out). */
function dayAfterTomorrowCheckout(): Date {
  return new Date(Date.UTC(2026, 6, 17, 15, 0, 0, 0));
}

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.now          = undefined;
  _hooks.platformSend = undefined;
  _hooks.smsSend      = undefined;
  mockSendPlatformMessage.mockResolvedValue(undefined);
  mockSendManagerSms.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue({});
});

// ════════════════════════════════════════════════════════════════════════════
// AC1 — worker.ts registration
// ════════════════════════════════════════════════════════════════════════════

describe('AC1 — checkout-reminder-sweep registered in worker.ts', () => {
  it('imports checkoutReminderSweepHandler and maps it to checkout-reminder-sweep', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, '../worker.ts'), 'utf8');
    expect(src).toMatch(/checkout-reminder-sweep/);
    expect(src).toMatch(/checkoutReminderSweepHandler/);
    expect(src).toMatch(/'checkout-reminder-sweep'\s*:\s*checkoutReminderSweepHandler/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — Skip entirely outside 19:30–21:00 ET
// ════════════════════════════════════════════════════════════════════════════

describe('AC2 — skips entirely when ET is outside 19:30–21:00', () => {
  it('getEasternMinutes returns correct value for a known UTC time', () => {
    // 2026-07-15 20:00 ET = 2026-07-16 00:00 UTC (EDT = UTC-4)
    const nowUTC = etTime(20, 0);
    expect(getEasternMinutes(nowUTC)).toBe(20 * 60); // 1200
  });

  const skipTimes = [
    { label: '08:00 ET (morning)',  hour: 8,  minute: 0  },
    { label: '19:00 ET (too early)', hour: 19, minute: 0  },
    { label: '19:29 ET (just before window)', hour: 19, minute: 29 },
    { label: '22:00 ET (after missed check)', hour: 22, minute: 0  },
    { label: '23:59 ET (late night)',          hour: 23, minute: 59 },
  ];

  it.each(skipTimes)('does nothing at $label', async ({ hour, minute }) => {
    _hooks.now = () => etTime(hour, minute);
    // findMany should not even be called for true skips (before window)
    // For times >= 22:00, we also skip after checking for candidates.
    // Regardless, no sends should happen.
    mockFindMany.mockResolvedValue([]);

    await checkoutReminderSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(mockSendManagerSms).not.toHaveBeenCalled();
  });

  it('skips (no DB query) when ET < 19:30', async () => {
    _hooks.now = () => etTime(10, 0);

    await checkoutReminderSweepHandler();

    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('skips (no DB query) when ET >= 22:00', async () => {
    _hooks.now = () => etTime(22, 30);

    await checkoutReminderSweepHandler();

    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('processes at 19:30 ET (window start)', async () => {
    _hooks.now = () => etTime(19, 30);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
  });

  it('processes at 20:59 ET (just before window closes)', async () => {
    _hooks.now = () => etTime(20, 59);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3 — Sends only to active bookings with tomorrow's checkout
// ════════════════════════════════════════════════════════════════════════════

describe('AC3 — sends only to active bookings with tomorrow\'s checkout', () => {
  it('getTomorrowUTCBounds returns the correct UTC range for a known ET now', () => {
    const nowUTC = etTime(20, 0); // 2026-07-15 20:00 ET
    const { start, end } = getTomorrowUTCBounds(nowUTC);

    // Tomorrow in ET is 2026-07-16.
    // EDT = UTC-4, so midnight 2026-07-16 ET = 2026-07-16 04:00 UTC.
    expect(start.toISOString()).toBe('2026-07-16T04:00:00.000Z');
    // Day-after-tomorrow midnight ET = 2026-07-17 04:00 UTC.
    expect(end.toISOString()).toBe('2026-07-17T04:00:00.000Z');
  });

  it('queries with status=active, checkout_reminder_sent=false, tomorrow UTC bounds', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([]);

    await checkoutReminderSweepHandler();

    const callArgs = mockFindMany.mock.calls[0][0];
    expect(callArgs.where.status).toBe('active');
    expect(callArgs.where.checkout_reminder_sent).toBe(false);
    expect(callArgs.where.checkout_datetime).toMatchObject({
      gte: expect.any(Date),
      lt:  expect.any(Date),
    });
  });

  it('sends to a booking whose checkout_datetime is tomorrow in ET', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
  });

  it('the tomorrow bounds exclude day-after-tomorrow (application-level verify)', () => {
    const nowUTC = etTime(20, 0);
    const { start, end } = getTomorrowUTCBounds(nowUTC);
    const dayAfter = dayAfterTomorrowCheckout(); // 2026-07-17 15:00 UTC

    expect(dayAfter >= start).toBe(true);
    expect(dayAfter < end).toBe(false); // dayAfter is OUTSIDE tomorrow's range
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 — checkout_reminder_enabled = false → skipped
// ════════════════════════════════════════════════════════════════════════════

describe('AC4 — checkout_reminder_enabled = false → skipped', () => {
  it('skips booking when checkout_reminder_enabled is false', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({
        checkout_datetime: tomorrowCheckout(),
        property: { ...mockProperty, checkout_reminder_enabled: false },
      }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'BK-1' }),
      expect.stringContaining('reminders disabled'),
    );
  });

  it('sends to enabled booking when mixed with disabled', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({
        id: 'BK-disabled',
        checkout_datetime: tomorrowCheckout(),
        property: { ...mockProperty, checkout_reminder_enabled: false },
      }),
      mockBooking({
        id: 'BK-enabled',
        checkout_datetime: tomorrowCheckout(),
      }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].where.id).toBe('BK-enabled');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 — Default template uses database values only
// ════════════════════════════════════════════════════════════════════════════

describe('AC5 — default template uses database values only', () => {
  it('substitutes all {{tokens}} with the provided vars', () => {
    const msg = buildCheckoutReminderMessage(null, {
      guestFirstName: 'Sam',
      checkoutTime:   '11:00 AM',
      checkoutSteps:  'Lock the door.',
      businessName:   'Shoreside Stays',
    });
    expect(msg).toContain('Sam');
    expect(msg).toContain('11:00 AM');
    expect(msg).toContain('Lock the door.');
    expect(msg).toContain('Shoreside Stays');
  });

  it('no unreplaced {{placeholders}} remain', () => {
    const msg = buildCheckoutReminderMessage(null, {
      guestFirstName: 'Sam',
      checkoutTime:   '11:00 AM',
      checkoutSteps:  'Steps here.',
      businessName:   'Biz',
    });
    expect(msg).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('uses custom template when checkout_reminder_template is set', () => {
    const custom = 'Hey {{guest_first_name}}, check out at {{checkout_time}}. — {{business_name}}';
    const msg = buildCheckoutReminderMessage(custom, {
      guestFirstName: 'Sam',
      checkoutTime:   '11:00 AM',
      checkoutSteps:  '',
      businessName:   'Shoreside Stays',
    });
    expect(msg).toBe('Hey Sam, check out at 11:00 AM. — Shoreside Stays');
    expect(msg).not.toContain('friendly reminder');
  });

  it('changing businessName changes the message output', () => {
    const vars = { guestFirstName: 'Sam', checkoutTime: '11 AM', checkoutSteps: '', businessName: 'A' };
    const msgA = buildCheckoutReminderMessage(null, vars);
    const msgB = buildCheckoutReminderMessage(null, { ...vars, businessName: 'B' });
    expect(msgA).toContain('A');
    expect(msgB).toContain('B');
    expect(msgB).not.toContain('\nA');
  });

  it('message sent during sweep contains DB values from property and account', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    const sentText: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(sentText).toContain('Sam');
    expect(sentText).toContain('11:00 AM');
    expect(sentText).toContain('Leave keys on counter. Lock the door.');
    expect(sentText).toContain('Shoreside Stays');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC6 — checkout_reminder_sent = true set on success
// ════════════════════════════════════════════════════════════════════════════

describe('AC6 — checkout_reminder_sent = true set on success', () => {
  it('updates checkout_reminder_sent = true after successful send', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'BK-1' },
        data:  expect.objectContaining({ checkout_reminder_sent: true }),
      }),
    );
  });

  it('sets checkout_reminder_sent_at to a Date on success', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    const data = mockUpdate.mock.calls[0][0].data;
    expect(data.checkout_reminder_sent_at).toBeInstanceOf(Date);
  });

  it('does not update flag when send fails', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);
    mockSendPlatformMessage.mockRejectedValue(new Error('timeout'));

    await checkoutReminderSweepHandler();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'BK-1' }),
      expect.stringContaining('send failed'),
    );
  });

  it('continues to process remaining bookings after one send failure', async () => {
    _hooks.now = () => etTime(20, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ id: 'BK-fail', checkout_datetime: tomorrowCheckout() }),
      mockBooking({ id: 'BK-ok',   checkout_datetime: tomorrowCheckout() }),
    ]);
    mockSendPlatformMessage
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);

    await checkoutReminderSweepHandler();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].where.id).toBe('BK-ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC7 — Missed send at 21:00 triggers manager alert
// ════════════════════════════════════════════════════════════════════════════

describe('AC7 — missed send at 21:00 triggers manager alert', () => {
  it('sends manager SMS at 21:00 ET when unsent reminders exist', async () => {
    _hooks.now = () => etTime(21, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
  });

  it('alert message contains guest name and property name', async () => {
    _hooks.now = () => etTime(21, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    const alertBody: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertBody).toContain('Sam Rivera');
    expect(alertBody).toContain('Palm View Suite');
    expect(alertBody).toContain('Shoreside Stays');
  });

  it('alert message contains CHECKOUT REMINDER MISSED', async () => {
    _hooks.now = () => etTime(21, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    const alertBody: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertBody).toContain('CHECKOUT REMINDER MISSED');
  });

  it('sends one alert per unsent booking at 21:00', async () => {
    _hooks.now = () => etTime(21, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ id: 'BK-1', checkout_datetime: tomorrowCheckout() }),
      mockBooking({ id: 'BK-2', checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendManagerSms).toHaveBeenCalledTimes(2);
  });

  it('does NOT send platform message at 21:00 (only manager SMS)', async () => {
    _hooks.now = () => etTime(21, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
  });

  it('does nothing at 21:00 when there are no unsent reminders', async () => {
    _hooks.now = () => etTime(21, 0);
    mockFindMany.mockResolvedValue([]);

    await checkoutReminderSweepHandler();

    expect(mockSendManagerSms).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('no missed reminders'),
    );
  });

  it('does NOT update checkout_reminder_sent at 21:00 (flag not set for missed)', async () => {
    _hooks.now = () => etTime(21, 0);
    mockFindMany.mockResolvedValue([
      mockBooking({ checkout_datetime: tomorrowCheckout() }),
    ]);

    await checkoutReminderSweepHandler();

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
