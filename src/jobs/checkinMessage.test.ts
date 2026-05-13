/**
 * T-028 — checkin-message-sweep tests
 *
 * AC1: boss.work("checkin-message-sweep") registered in worker.ts
 * AC2: Booking within the configurable window receives the check-in message
 * AC3: Booking outside the window is skipped
 * AC4: checkin_message_enabled = false -> property skipped
 * AC5: checkin_message_template used when set; default PRD template when not
 * AC6: Zero hardcoded values — all substitutions from DB
 * AC7: checkin_message_sent = true and checkin_message_sent_at set on success
 * AC8: sendImmediateCheckinMessage exported and functional
 */

import {
  checkinMessageSweepHandler,
  sendImmediateCheckinMessage,
  buildCheckinMessage,
  _hooks,
} from './checkinMessage';

// ── Prisma mock ──────────────────────────────────────────────────────────────

const mockFindMany   = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate     = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    bookings: {
      findMany:   (...a: any[]) => mockFindMany(...a),
      findUnique: (...a: any[]) => mockFindUnique(...a),
      update:     (...a: any[]) => mockUpdate(...a),
    },
  },
}));

// ── workOrderCreation mock ────────────────────────────────────────────────────

const mockSendPlatformMessage = jest.fn();

jest.mock('./workOrderCreation', () => ({
  sendPlatformMessage: (...a: any[]) => mockSendPlatformMessage(...a),
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
  business_name:       'Sunset Rentals',
  twilio_phone_number: '+15559999000',
  manager_phone:       '+15550001111',
  alert_channel:       'sms',
};

const mockProperty = {
  id:                        'PROP-1',
  account_id:                'ACC-1',
  name:                      'Beachfront Bungalow',
  address:                   '1 Shore Dr',
  checkin_time:              '3:00 PM',
  checkout_time:             '11:00 AM',
  door_access_instructions:  'Lock box code 9876',
  parking_instructions:      'Driveway',
  wifi_name:                 'BungalowWifi',
  wifi_password:             'waves2026',
  house_rules:               'No smoking, no parties',
  amenities:                 'Pool',
  checkin_message_enabled:   true,
  checkin_message_hours_before: 24,
  checkin_message_template:  null,
  checkin_message_sent:      false,
};

const mockBooking = (overrides: Record<string, any> = {}) => ({
  id:                   'BK-1',
  account_id:           'ACC-1',
  property_id:          'PROP-1',
  guest_first_name:     'Alex',
  guest_last_name:      'Smith',
  guest_platform_id:    'GUEST-1',
  platform:             'airbnb',
  checkin_message_sent: false,
  property:             { ...mockProperty },
  account:              { ...mockAccount },
  ...overrides,
});

/** Returns a checkin_datetime that lands exactly in the 24h window. */
function inWindowDatetime(hoursBeforeDefault = 24): Date {
  return new Date(Date.now() + hoursBeforeDefault * 60 * 60 * 1000);
}

/** Returns a checkin_datetime clearly outside the 24h ± 0.5h window. */
function outsideWindowDatetime(): Date {
  return new Date(Date.now() + 36 * 60 * 60 * 1000); // 36h from now — beyond 24.5h
}

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.platformSend = undefined;
  mockSendPlatformMessage.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue({});
});

// ════════════════════════════════════════════════════════════════════════════
// AC1 — worker.ts registration
// ════════════════════════════════════════════════════════════════════════════

describe('AC1 — checkin-message-sweep registered in worker.ts', () => {
  it('worker.ts imports checkinMessageSweepHandler and registers it', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, '../worker.ts'), 'utf8');
    expect(src).toMatch(/checkin-message-sweep/);
    expect(src).toMatch(/checkinMessageSweepHandler/);
    expect(src).toMatch(/'checkin-message-sweep'\s*:\s*checkinMessageSweepHandler/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — Booking within window receives the check-in message
// ════════════════════════════════════════════════════════════════════════════

describe('AC2 — booking within window receives check-in message', () => {
  it('calls sendPlatformMessage for a booking exactly in the 24h window', async () => {
    const booking = mockBooking({ checkin_datetime: inWindowDatetime(24) });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
  });

  it('queries bookings with status=upcoming and checkin_message_sent=false', async () => {
    mockFindMany.mockResolvedValue([]);

    await checkinMessageSweepHandler();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status:               'upcoming',
          checkin_message_sent: false,
        }),
      }),
    );
  });

  it('sends a booking with a non-default hours_before (e.g. 48h)', async () => {
    const booking = mockBooking({
      checkin_datetime: inWindowDatetime(48),
      property: { ...mockProperty, checkin_message_hours_before: 48 },
    });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3 — Booking outside window is skipped
// ════════════════════════════════════════════════════════════════════════════

describe('AC3 — booking outside window is skipped', () => {
  it('skips a booking whose checkin_datetime is outside the ±0.5h window', async () => {
    const booking = mockBooking({ checkin_datetime: outsideWindowDatetime() });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'BK-1' }),
      expect.stringContaining('outside window'),
    );
  });

  it('sends only the in-window booking when mixed candidates are returned', async () => {
    const inWindow  = mockBooking({ id: 'BK-in',  checkin_datetime: inWindowDatetime(24) });
    const outWindow = mockBooking({ id: 'BK-out', checkin_datetime: outsideWindowDatetime() });
    mockFindMany.mockResolvedValue([inWindow, outWindow]);

    await checkinMessageSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 — checkin_message_enabled = false → property skipped
// ════════════════════════════════════════════════════════════════════════════

describe('AC4 — checkin_message_enabled = false → skipped', () => {
  it('skips the booking when checkin_message_enabled is false', async () => {
    const booking = mockBooking({
      checkin_datetime: inWindowDatetime(24),
      property: { ...mockProperty, checkin_message_enabled: false },
    });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'BK-1' }),
      expect.stringContaining('messaging disabled'),
    );
  });

  it('does not update checkin_message_sent when disabled', async () => {
    const booking = mockBooking({
      checkin_datetime: inWindowDatetime(24),
      property: { ...mockProperty, checkin_message_enabled: false },
    });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 — Template selection: custom vs default
// ════════════════════════════════════════════════════════════════════════════

describe('AC5 — custom template used when set; default when null', () => {
  it('uses the default PRD template when checkin_message_template is null', () => {
    const msg = buildCheckinMessage(null, {
      guestFirstName: 'Alex',
      propertyName:   'The Cottage',
      checkinTime:    '3:00 PM',
      address:        '1 Shore Dr',
      doorAccess:     'Code: 1234',
      parking:        'Driveway',
      wifiName:       'CottageWifi',
      wifiPassword:   'secret',
      houseRules:     'No smoking',
      businessName:   'Sunset Rentals',
    });
    expect(msg).toContain("We're so excited to welcome you");
    expect(msg).toContain('Alex');
    expect(msg).toContain('The Cottage');
  });

  it('uses the custom template when checkin_message_template is provided', () => {
    const custom = 'Hey {{guest_first_name}}, your stay at {{property_name}} starts soon!';
    const msg = buildCheckinMessage(custom, {
      guestFirstName: 'Alex',
      propertyName:   'The Cottage',
      checkinTime:    '3:00 PM',
      address:        '1 Shore Dr',
      doorAccess:     '',
      parking:        '',
      wifiName:       '',
      wifiPassword:   '',
      houseRules:     '',
      businessName:   'Sunset Rentals',
    });
    expect(msg).toBe('Hey Alex, your stay at The Cottage starts soon!');
    expect(msg).not.toContain("We're so excited");
  });

  it('passes custom template to sendPlatformMessage during sweep', async () => {
    const customTpl = 'Custom: {{guest_first_name}} at {{property_name}}. — {{business_name}}';
    const booking = mockBooking({
      checkin_datetime: inWindowDatetime(24),
      property: { ...mockProperty, checkin_message_template: customTpl },
    });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    const sentText: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(sentText).toBe('Custom: Alex at Beachfront Bungalow. — Sunset Rentals');
    expect(sentText).not.toContain("We're so excited");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC6 — Zero hardcoded values
// ════════════════════════════════════════════════════════════════════════════

describe('AC6 — all substitutions come from DB values', () => {
  it('each template variable reflects the injected DB value', () => {
    const msg = buildCheckinMessage(null, {
      guestFirstName: 'GUEST_NAME',
      propertyName:   'PROPERTY_NAME',
      checkinTime:    'CHECKIN_TIME',
      address:        'ADDRESS_VAL',
      doorAccess:     'DOOR_ACCESS_VAL',
      parking:        'PARKING_VAL',
      wifiName:       'WIFI_NAME_VAL',
      wifiPassword:   'WIFI_PASS_VAL',
      houseRules:     'RULES_VAL',
      businessName:   'BIZ_NAME_VAL',
    });
    expect(msg).toContain('GUEST_NAME');
    expect(msg).toContain('PROPERTY_NAME');
    expect(msg).toContain('CHECKIN_TIME');
    expect(msg).toContain('ADDRESS_VAL');
    expect(msg).toContain('DOOR_ACCESS_VAL');
    expect(msg).toContain('PARKING_VAL');
    expect(msg).toContain('WIFI_NAME_VAL');
    expect(msg).toContain('WIFI_PASS_VAL');
    expect(msg).toContain('RULES_VAL');
    expect(msg).toContain('BIZ_NAME_VAL');
  });

  it('changing business_name produces a different message', () => {
    const vars = {
      guestFirstName: 'Alex', propertyName: 'The Cottage', checkinTime: '3:00 PM',
      address: '1 Shore Dr', doorAccess: '', parking: '', wifiName: '',
      wifiPassword: '', houseRules: '', businessName: 'Brand A',
    };
    const msgA = buildCheckinMessage(null, vars);
    const msgB = buildCheckinMessage(null, { ...vars, businessName: 'Brand B' });
    expect(msgA).toContain('Brand A');
    expect(msgB).toContain('Brand B');
    expect(msgB).not.toContain('Brand A');
  });

  it('no unreplaced {{placeholders}} remain in the output', () => {
    const msg = buildCheckinMessage(null, {
      guestFirstName: 'Alex', propertyName: 'The Cottage', checkinTime: '3:00 PM',
      address: '1 Shore Dr', doorAccess: 'Code 1234', parking: 'Street',
      wifiName: 'WiFi1', wifiPassword: 'pass', houseRules: 'No parties',
      businessName: 'Sunset Rentals',
    });
    expect(msg).not.toMatch(/\{\{[^}]+\}\}/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC7 — checkin_message_sent = true and checkin_message_sent_at set
// ════════════════════════════════════════════════════════════════════════════

describe('AC7 — flags updated on success', () => {
  it('updates checkin_message_sent = true after successful send', async () => {
    const booking = mockBooking({ checkin_datetime: inWindowDatetime(24) });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'BK-1' },
        data:  expect.objectContaining({ checkin_message_sent: true }),
      }),
    );
  });

  it('sets checkin_message_sent_at to a Date on success', async () => {
    const booking = mockBooking({ checkin_datetime: inWindowDatetime(24) });
    mockFindMany.mockResolvedValue([booking]);

    await checkinMessageSweepHandler();

    const updateData = mockUpdate.mock.calls[0][0].data;
    expect(updateData.checkin_message_sent_at).toBeInstanceOf(Date);
  });

  it('does NOT update flags when send fails', async () => {
    const booking = mockBooking({ checkin_datetime: inWindowDatetime(24) });
    mockFindMany.mockResolvedValue([booking]);
    mockSendPlatformMessage.mockRejectedValue(new Error('platform down'));

    await checkinMessageSweepHandler();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'BK-1' }),
      expect.stringContaining('send failed'),
    );
  });

  it('continues to next booking after a send failure', async () => {
    const failBooking = mockBooking({ id: 'BK-fail', checkin_datetime: inWindowDatetime(24) });
    const okBooking   = mockBooking({ id: 'BK-ok',   checkin_datetime: inWindowDatetime(24) });
    mockFindMany.mockResolvedValue([failBooking, okBooking]);
    mockSendPlatformMessage
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    await checkinMessageSweepHandler();

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(2);
    // Only the OK booking should have its flags updated.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].where.id).toBe('BK-ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC8 — sendImmediateCheckinMessage exported and functional
// ════════════════════════════════════════════════════════════════════════════

describe('AC8 — sendImmediateCheckinMessage exported and functional', () => {
  it('is exported as a named function', () => {
    expect(typeof sendImmediateCheckinMessage).toBe('function');
  });

  it('sends immediately bypassing the window check', async () => {
    // Booking checkin is 6 hours away — outside a 24h window.
    const booking = mockBooking({ checkin_datetime: new Date(Date.now() + 6 * 60 * 60 * 1000) });
    mockFindUnique.mockResolvedValue(booking);

    await sendImmediateCheckinMessage('BK-1');

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'BK-1' },
        data:  expect.objectContaining({ checkin_message_sent: true }),
      }),
    );
  });

  it('skips when checkin_message_enabled = false', async () => {
    const booking = mockBooking({
      property: { ...mockProperty, checkin_message_enabled: false },
    });
    mockFindUnique.mockResolvedValue(booking);

    await sendImmediateCheckinMessage('BK-1');

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('skips when checkin_message_sent is already true', async () => {
    const booking = mockBooking({ checkin_message_sent: true });
    mockFindUnique.mockResolvedValue(booking);

    await sendImmediateCheckinMessage('BK-1');

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
  });

  it('warns and returns when booking is not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    await sendImmediateCheckinMessage('MISSING-BK');

    expect(mockSendPlatformMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: 'MISSING-BK' }),
      expect.any(String),
    );
  });
});
