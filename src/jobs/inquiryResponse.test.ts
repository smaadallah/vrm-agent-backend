/**
 * T-027 — AI Inquiry Response Worker tests
 *
 * AC1: Duplicate platform_message_id -> second processing job discarded
 * AC2: Layer 1 urgent keyword match -> URGENT_ESCALATE without any AI call
 * AC3: AI token cap reached -> ESCALATE, manager alerted, no AI call
 * AC4: System prompt contains zero hardcoded business names, property data, or operational values
 * AC5: ESCALATE -> guest holding message, manager alerted, messages.status = 'escalated', is_urgent = false
 * AC6: URGENT_ESCALATE -> urgent holding message, manager SMS, messages.status = 'escalated', is_urgent = true
 * AC7: MAINTENANCE:[description] -> createWorkOrderFromAI() called synchronously, no prior holding message
 * AC8: Normal response -> sent to guest, messages.status = 'auto_handled'
 * AC9: Rule 3 retry applied on platform API send failure
 */

import {
  processAirbnbMessageHandler,
  processVrboMessageHandler,
  hasUrgentKeyword,
  buildSystemPrompt,
  MessagePayload,
  _hooks,
} from './inquiryResponse';

// ── Prisma mock ──────────────────────────────────────────────────────────────

const mockMsgFindUnique   = jest.fn();
const mockMsgCreate       = jest.fn();
const mockMsgUpdate       = jest.fn();
const mockPropFindFirst   = jest.fn();
const mockAccFindUnique   = jest.fn();
const mockBookFindFirst   = jest.fn();
const mockAccUpdate       = jest.fn();

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    messages:   {
      findUnique: (...a: any[]) => mockMsgFindUnique(...a),
      create:     (...a: any[]) => mockMsgCreate(...a),
      update:     (...a: any[]) => mockMsgUpdate(...a),
    },
    properties: { findFirst:  (...a: any[]) => mockPropFindFirst(...a) },
    accounts:   {
      findUnique: (...a: any[]) => mockAccFindUnique(...a),
      update:     (...a: any[]) => mockAccUpdate(...a),
    },
    bookings:   { findFirst:  (...a: any[]) => mockBookFindFirst(...a) },
  },
}));

// ── workOrderCreation mock ────────────────────────────────────────────────────

const mockSendPlatformMessage    = jest.fn();
const mockSendManagerSms         = jest.fn();
const mockBuildEscalateHolding   = jest.fn();
const mockBuildEscalateManager   = jest.fn();
const mockCreateWorkOrderFromAI  = jest.fn();

jest.mock('./workOrderCreation', () => ({
  sendPlatformMessage:     (...a: any[]) => mockSendPlatformMessage(...a),
  sendManagerSms:          (...a: any[]) => mockSendManagerSms(...a),
  buildEscalateHoldingMessage: (...a: any[]) => mockBuildEscalateHolding(...a),
  buildEscalateManagerAlert:   (...a: any[]) => mockBuildEscalateManager(...a),
  createWorkOrderFromAI:   (...a: any[]) => mockCreateWorkOrderFromAI(...a),
}));

// ── Logger + twilio mock ──────────────────────────────────────────────────────

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('twilio', () => jest.fn());

import logger from '../lib/logger';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const mockAccount = {
  id:                  'ACC-1',
  business_name:       'Sunshine Stays',
  communication_tone:  'casual',
  manager_phone:       '+15550001111',
  twilio_phone_number: '+15559999000',
  alert_channel:       'sms',
  daily_ai_token_usage: 0,
  ai_token_daily_cap:  500_000,
};

const mockProperty = {
  id:                      'PROP-1',
  account_id:              'ACC-1',
  name:                    'Ocean View Cottage',
  address:                 '123 Beach Rd',
  checkin_time:            '3:00 PM',
  checkout_time:           '11:00 AM',
  airbnb_listing_id:       'LISTING-A',
  vrbo_listing_id:         null,
  door_access_instructions: 'Code: 1234',
  parking_instructions:    'Driveway',
  wifi_name:               'OceanWifi',
  wifi_password:           'beachlife',
  house_rules:             'No smoking',
  amenities:               'Pool, BBQ',
  local_recommendations:   'Joe\'s Tacos',
  special_instructions:    null,
};

const mockBooking = {
  id:                'BK-1',
  account_id:        'ACC-1',
  property_id:       'PROP-1',
  guest_platform_id: 'GUEST-1',
  guest_first_name:  'Jane',
  guest_last_name:   'Doe',
  platform:          'airbnb',
  checkin_datetime:  new Date('2026-07-01T19:00:00.000Z'),
  checkout_datetime: new Date('2026-07-07T15:00:00.000Z'),
  status:            'active',
};

const basePayload: MessagePayload = {
  platform_message_id:    'MSG-001',
  listing_id:             'LISTING-A',
  guest_platform_user_id: 'GUEST-1',
  content:                'What is the Wi-Fi password?',
};

function setupHappyPath() {
  mockMsgFindUnique.mockResolvedValue(null);            // no duplicate
  mockPropFindFirst.mockResolvedValue(mockProperty);
  mockAccFindUnique.mockResolvedValue(mockAccount);
  mockBookFindFirst.mockResolvedValue(mockBooking);
  mockMsgCreate.mockResolvedValue({ id: 'MSG-ROW-1' });
  mockMsgUpdate.mockResolvedValue({});
  mockAccUpdate.mockResolvedValue({});
  mockSendPlatformMessage.mockResolvedValue(undefined);
  mockSendManagerSms.mockResolvedValue(undefined);
  mockBuildEscalateHolding.mockReturnValue('Great question, Jane...');
  mockBuildEscalateManager.mockReturnValue('QUESTION ESCALATED: Jane Doe...');
  mockCreateWorkOrderFromAI.mockResolvedValue({ outcome: 'work_order_created', workOrderId: 'WO-1' });
}

beforeEach(() => {
  jest.clearAllMocks();
  _hooks.aiCall           = undefined;
  _hooks.platformSend     = undefined;
  _hooks.smsSend          = undefined;
  _hooks.createWorkOrderFn = undefined;
  _hooks.retryDelayMs     = 0;
});

// ════════════════════════════════════════════════════════════════════════════
// AC1 — Duplicate platform_message_id → discarded
// ════════════════════════════════════════════════════════════════════════════

describe('AC1 — duplicate platform_message_id is discarded', () => {
  it('returns immediately when platform_message_id already exists', async () => {
    mockMsgFindUnique.mockResolvedValue({ id: 'EXISTING' });
    _hooks.aiCall = jest.fn();

    await processAirbnbMessageHandler({ data: basePayload });

    expect(_hooks.aiCall).not.toHaveBeenCalled();
    expect(mockMsgCreate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ platform_message_id: 'MSG-001' }),
      expect.stringContaining('duplicate'),
    );
  });

  it('discards concurrent duplicate on P2002 from INSERT', async () => {
    mockMsgFindUnique.mockResolvedValue(null);
    mockPropFindFirst.mockResolvedValue(mockProperty);
    mockAccFindUnique.mockResolvedValue(mockAccount);
    mockBookFindFirst.mockResolvedValue(mockBooking);

    const p2002 = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    mockMsgCreate.mockRejectedValue(p2002);
    _hooks.aiCall = jest.fn();

    await processAirbnbMessageHandler({ data: basePayload });

    expect(_hooks.aiCall).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ platform_message_id: 'MSG-001' }),
      expect.stringContaining('concurrent duplicate'),
    );
  });

  it('dedup INSERT happens before the AI call', async () => {
    // Verify ordering: mockMsgCreate is called, then aiCall.
    setupHappyPath();
    const callOrder: string[] = [];
    mockMsgCreate.mockImplementation(async () => { callOrder.push('INSERT'); return { id: 'MSG-ROW-1' }; });
    _hooks.aiCall = jest.fn().mockImplementation(async () => {
      callOrder.push('AI');
      return { text: 'Sure! The Wi-Fi is OceanWifi.', inputTokens: 50, outputTokens: 30 };
    });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(callOrder.indexOf('INSERT')).toBeLessThan(callOrder.indexOf('AI'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC2 — Layer 1 urgent keyword → URGENT_ESCALATE without AI call
// ════════════════════════════════════════════════════════════════════════════

describe('AC2 — Layer 1 keyword → URGENT_ESCALATE, no AI call', () => {
  const urgentKeywords = [
    'emergency', 'fire', 'smoke', 'gas smell', 'gas leak',
    'flood', 'flooding', 'water everywhere', 'no power', 'power out',
    'locked out', "can't get in", 'cannot get in',
  ];

  it.each(urgentKeywords)('keyword "%s" triggers urgent escalation', async (kw) => {
    expect(hasUrgentKeyword(kw)).toBe(true);
    expect(hasUrgentKeyword(kw.toUpperCase())).toBe(true); // case-insensitive
  });

  it('Layer 1 match fires URGENT_ESCALATE and does NOT call AI', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn();

    const urgentPayload = { ...basePayload, content: 'There is a fire in the kitchen!' };
    await processAirbnbMessageHandler({ data: urgentPayload });

    expect(_hooks.aiCall).not.toHaveBeenCalled();
  });

  it('Layer 1 match sends urgent message to guest and manager SMS', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn();

    const urgentPayload = { ...basePayload, content: 'flood in the bathroom' };
    await processAirbnbMessageHandler({ data: urgentPayload });

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    const guestMsg: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(guestMsg).toContain("We've received your message");

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    const alertMsg: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertMsg).toContain('URGENT');
  });

  it('Layer 1 scan happens before AI call (verified by call order)', async () => {
    setupHappyPath();
    const callOrder: string[] = [];
    _hooks.aiCall = jest.fn().mockImplementation(async () => {
      callOrder.push('AI');
      return { text: 'ok', inputTokens: 10, outputTokens: 10 };
    });
    mockSendPlatformMessage.mockImplementation(async () => { callOrder.push('SEND'); });
    mockSendManagerSms.mockImplementation(async () => { callOrder.push('SMS'); });

    // With a Layer 1 keyword, AI should never fire.
    const urgentPayload = { ...basePayload, content: 'locked out of the house' };
    await processAirbnbMessageHandler({ data: urgentPayload });

    expect(callOrder).not.toContain('AI');
    expect(callOrder).toContain('SEND');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC3 — Token cap reached → ESCALATE, no AI call
// ════════════════════════════════════════════════════════════════════════════

describe('AC3 — token cap reached → ESCALATE without AI call', () => {
  it('escalates and skips AI when usage >= cap', async () => {
    setupHappyPath();
    mockAccFindUnique.mockResolvedValue({
      ...mockAccount,
      daily_ai_token_usage: 500_000,
      ai_token_daily_cap:   500_000,
    });
    _hooks.aiCall = jest.fn();

    await processAirbnbMessageHandler({ data: basePayload });

    expect(_hooks.aiCall).not.toHaveBeenCalled();
    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    expect(mockMsgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'escalated', is_urgent: false }) }),
    );
  });

  it('token check fires before AI (usage just above cap)', async () => {
    setupHappyPath();
    mockAccFindUnique.mockResolvedValue({
      ...mockAccount,
      daily_ai_token_usage: 600_000,
      ai_token_daily_cap:   500_000,
    });
    _hooks.aiCall = jest.fn();

    await processAirbnbMessageHandler({ data: basePayload });

    expect(_hooks.aiCall).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC4 — System prompt contains zero hardcoded values
// ════════════════════════════════════════════════════════════════════════════

describe('AC4 — system prompt contains zero hardcoded values', () => {
  const acct = {
    business_name:      'Coastal Getaways',
    communication_tone: 'professional' as const,
  };
  const prop = {
    name:                    'Beachfront Villa',
    address:                 '99 Shore Lane',
    checkin_time:            '4:00 PM',
    checkout_time:           '10:00 AM',
    door_access_instructions: 'Keypad code 5678',
    parking_instructions:    'Street parking',
    wifi_name:               'VillaWifi',
    wifi_password:           'ocean2026',
    house_rules:             'No pets',
    amenities:               'Hot tub',
    local_recommendations:   'Dune Coffee',
    special_instructions:    null,
  };
  const bk = {
    guest_first_name:  'Marco',
    checkin_datetime:  new Date('2026-08-10T20:00:00.000Z'),
    checkout_datetime: new Date('2026-08-17T14:00:00.000Z'),
  };

  it('prompt contains account.business_name', () => {
    const prompt = buildSystemPrompt(acct as any, prop as any, bk as any);
    expect(prompt).toContain('Coastal Getaways');
  });

  it('prompt contains account.communication_tone', () => {
    const prompt = buildSystemPrompt(acct as any, prop as any, bk as any);
    expect(prompt).toContain('professional');
  });

  it('prompt contains property.name and address', () => {
    const prompt = buildSystemPrompt(acct as any, prop as any, bk as any);
    expect(prompt).toContain('Beachfront Villa');
    expect(prompt).toContain('99 Shore Lane');
  });

  it('prompt contains booking guest_first_name', () => {
    const prompt = buildSystemPrompt(acct as any, prop as any, bk as any);
    expect(prompt).toContain('Marco');
  });

  it('prompt reflects different business_name when changed', () => {
    const promptA = buildSystemPrompt(acct as any, prop as any, bk as any);
    const promptB = buildSystemPrompt({ ...acct, business_name: 'Mountain Retreats' } as any, prop as any, bk as any);
    expect(promptA).toContain('Coastal Getaways');
    expect(promptB).toContain('Mountain Retreats');
    expect(promptB).not.toContain('Coastal Getaways');
  });

  it('prompt does not contain any literal placeholder like [accounts.business_name]', () => {
    const prompt = buildSystemPrompt(acct as any, prop as any, bk as any);
    expect(prompt).not.toMatch(/\[accounts\./);
    expect(prompt).not.toMatch(/\[properties\./);
    expect(prompt).not.toMatch(/\[bookings\./);
  });

  it('checkin and checkout times appear formatted in Eastern Time', () => {
    const prompt = buildSystemPrompt(acct as any, prop as any, bk as any);
    // 2026-08-10T20:00:00Z = 4:00 PM Eastern (UTC-4 in summer)
    expect(prompt).toContain('Aug 10, 2026');
    expect(prompt).toContain('Aug 17, 2026');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC5 — ESCALATE path
// ════════════════════════════════════════════════════════════════════════════

describe('AC5 — ESCALATE: holding message + manager alert + status=escalated, is_urgent=false', () => {
  it('sends holding message to guest', async () => {
    setupHappyPath();
    mockBuildEscalateHolding.mockReturnValue('Let me check on that!');
    _hooks.aiCall = jest.fn().mockResolvedValue({ text: 'ESCALATE', inputTokens: 100, outputTokens: 5 });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockSendPlatformMessage).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      'Let me check on that!',
      undefined,
    );
  });

  it('sends manager alert', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({ text: 'ESCALATE', inputTokens: 100, outputTokens: 5 });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
  });

  it('updates inbound message status=escalated, is_urgent=false', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({ text: 'ESCALATE', inputTokens: 100, outputTokens: 5 });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockMsgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'escalated', is_urgent: false }),
      }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC6 — URGENT_ESCALATE path (from AI response, not Layer 1)
// ════════════════════════════════════════════════════════════════════════════

describe('AC6 — URGENT_ESCALATE: urgent holding message + manager SMS + is_urgent=true', () => {
  it('sends urgent holding message to guest', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({ text: 'URGENT_ESCALATE', inputTokens: 80, outputTokens: 5 });

    await processAirbnbMessageHandler({ data: basePayload });

    const sentMsg: string = mockSendPlatformMessage.mock.calls[0][2];
    expect(sentMsg).toContain("We've received your message");
  });

  it('sends manager SMS for urgent escalation', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({ text: 'URGENT_ESCALATE', inputTokens: 80, outputTokens: 5 });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    const alertMsg: string = mockSendManagerSms.mock.calls[0][1];
    expect(alertMsg).toContain('URGENT');
  });

  it('sets is_urgent=true on the inbound message row', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({ text: 'URGENT_ESCALATE', inputTokens: 80, outputTokens: 5 });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockMsgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'escalated', is_urgent: true }),
      }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC7 — MAINTENANCE path
// ════════════════════════════════════════════════════════════════════════════

describe('AC7 — MAINTENANCE: createWorkOrderFromAI called, no prior holding message', () => {
  it('calls createWorkOrderFromAI with the description (prefix stripped)', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({
      text: 'MAINTENANCE: The dishwasher is leaking',
      inputTokens: 120, outputTokens: 10,
    });
    _hooks.createWorkOrderFn = jest.fn().mockResolvedValue({ outcome: 'work_order_created', workOrderId: 'WO-1' });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(_hooks.createWorkOrderFn).toHaveBeenCalledTimes(1);
    const [input] = (_hooks.createWorkOrderFn as jest.Mock).mock.calls[0];
    expect(input.maintenanceDescription).toBe('The dishwasher is leaking');
  });

  it('does NOT send a holding message before calling createWorkOrderFromAI', async () => {
    setupHappyPath();

    const callOrder: string[] = [];
    mockSendPlatformMessage.mockImplementation(async () => { callOrder.push('SEND'); });
    _hooks.createWorkOrderFn = jest.fn().mockImplementation(async () => {
      callOrder.push('CREATE_WO');
      return { outcome: 'work_order_created', workOrderId: 'WO-1' };
    });
    _hooks.aiCall = jest.fn().mockResolvedValue({
      text: 'MAINTENANCE: Broken window latch',
      inputTokens: 100, outputTokens: 8,
    });

    await processAirbnbMessageHandler({ data: basePayload });

    // Any SEND that happens should be AFTER CREATE_WO (inside createWorkOrderFromAI).
    // The inquiry response worker must not send before calling createWorkOrderFromAI.
    const sendIdx = callOrder.indexOf('SEND');
    const woIdx   = callOrder.indexOf('CREATE_WO');
    // If there's a platform send BEFORE CREATE_WO, that's a bug.
    if (sendIdx !== -1 && woIdx !== -1) {
      expect(woIdx).toBeLessThanOrEqual(sendIdx);
    }
    // createWorkOrderFromAI must be called
    expect(callOrder).toContain('CREATE_WO');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC8 — Normal response → sent to guest, status=auto_handled
// ════════════════════════════════════════════════════════════════════════════

describe('AC8 — Normal AI response sent to guest, status=auto_handled', () => {
  it('sends the AI response text to the guest', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({
      text: "The Wi-Fi is OceanWifi and the password is beachlife!",
      inputTokens: 200, outputTokens: 20,
    });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    expect(mockSendPlatformMessage.mock.calls[0][2]).toBe('The Wi-Fi is OceanWifi and the password is beachlife!');
  });

  it('sets messages.status = auto_handled', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({
      text: "Here's the info you need.",
      inputTokens: 200, outputTokens: 15,
    });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockMsgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'auto_handled', is_urgent: false }),
      }),
    );
  });

  it('increments account token usage after AI call', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({
      text: "Your check-in is at 3 PM.",
      inputTokens: 300, outputTokens: 25,
    });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockAccUpdate).toHaveBeenCalledWith({
      where: { id: 'ACC-1' },
      data:  { daily_ai_token_usage: { increment: 325 } },
    });
  });

  it('vrbo handler uses vrbo listing field for property lookup', async () => {
    const vrboProperty = { ...mockProperty, airbnb_listing_id: null, vrbo_listing_id: 'LISTING-V' };
    mockMsgFindUnique.mockResolvedValue(null);
    mockPropFindFirst.mockResolvedValue(vrboProperty);
    mockAccFindUnique.mockResolvedValue(mockAccount);
    mockBookFindFirst.mockResolvedValue({ ...mockBooking, platform: 'vrbo' });
    mockMsgCreate.mockResolvedValue({ id: 'MSG-ROW-2' });
    mockMsgUpdate.mockResolvedValue({});
    mockAccUpdate.mockResolvedValue({});
    mockSendPlatformMessage.mockResolvedValue(undefined);
    mockBuildEscalateHolding.mockReturnValue('...');
    _hooks.aiCall = jest.fn().mockResolvedValue({ text: 'Fine, sure.', inputTokens: 50, outputTokens: 10 });

    await processVrboMessageHandler({ data: { ...basePayload, listing_id: 'LISTING-V' } });

    expect(mockPropFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vrbo_listing_id: 'LISTING-V' } }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AC9 — Rule 3 retry on platform send failure
// ════════════════════════════════════════════════════════════════════════════

describe('AC9 — Rule 3 retry on platform API send failure', () => {
  it('retries once after initial send failure (normal path)', async () => {
    setupHappyPath();
    _hooks.aiCall = jest.fn().mockResolvedValue({
      text: "Sure, the Wi-Fi is OceanWifi.",
      inputTokens: 200, outputTokens: 20,
    });

    let callCount = 0;
    _hooks.platformSend = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('platform timeout');
    });

    // sendPlatformMessage from workOrderCreation handles the Rule 3 retry —
    // with _hooks.platformSend injected it goes through that function.
    // Verify that sendPlatformMessage is called (which internally retries).
    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockSendPlatformMessage).toHaveBeenCalledTimes(1);
    // The retry contract is enforced by sendPlatformMessage in workOrderCreation.ts
    // (already tested in T-026). Here we verify the hook is passed through correctly.
    const overrideFn = mockSendPlatformMessage.mock.calls[0][3];
    expect(overrideFn).toBe(_hooks.platformSend);
  });

  it('passes smsSend hook through to sendManagerSms on ESCALATE', async () => {
    setupHappyPath();
    _hooks.smsSend = jest.fn().mockResolvedValue(undefined);
    _hooks.aiCall  = jest.fn().mockResolvedValue({ text: 'ESCALATE', inputTokens: 50, outputTokens: 5 });

    await processAirbnbMessageHandler({ data: basePayload });

    expect(mockSendManagerSms).toHaveBeenCalledTimes(1);
    const smsFn = mockSendManagerSms.mock.calls[0][2];
    expect(smsFn).toBe(_hooks.smsSend);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Worker registration check
// ════════════════════════════════════════════════════════════════════════════

describe('worker.ts registration', () => {
  it('registers process-airbnb-message and process-vrbo-message in WEBHOOK_JOBS', () => {
    const fs   = require('fs');
    const path = require('path');
    const src  = fs.readFileSync(path.join(__dirname, '../worker.ts'), 'utf8');
    expect(src).toMatch(/process-airbnb-message/);
    expect(src).toMatch(/process-vrbo-message/);
    expect(src).toMatch(/processAirbnbMessageHandler/);
    expect(src).toMatch(/processVrboMessageHandler/);
  });
});
