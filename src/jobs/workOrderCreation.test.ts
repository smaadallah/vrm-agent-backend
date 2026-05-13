/**
 * T-026 verification — Feature 3.1 Trigger A — Work Order Creation Worker Function
 *
 * AC1  createWorkOrderFromAI exported from workOrderCreation.ts
 * AC2  Empty maintenanceDescription → standard ESCALATE path; no work_orders row created
 * AC3  Priority classification matches PRD Section 8.1 keyword table (one from each tier)
 * AC4  work_orders row inserted with reported_by='guest', status='open', source_message_id set
 * AC5  Duplicate source_message_id → unique constraint handled silently (function continues)
 * AC6  Guest acknowledgment uses {{ai_summary}} and {{business_name}} from accounts row
 * AC7  Manager SMS sent for Urgent and High priority only (not Medium, not Low)
 * AC8  messages.maintenance_triggered = true set after processing
 *
 * Run: npx ts-node src/jobs/workOrderCreation.test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import {
  classifyPriority,
  buildGuestAckMessage,
  buildManagerSmsText,
  buildEscalateHoldingMessage,
  generateAiSummary,
  createWorkOrderFromAI,
  type CreateWorkOrderInput,
} from './workOrderCreation';

import { WorkOrderPriority } from '@prisma/client';
import type { accounts, properties, bookings, messages } from '@prisma/client';
import prisma from '../lib/prisma';

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

// ── Test fixtures ─────────────────────────────────────────────────────────────

const mockAccount = {
  id: 'acc-001',
  business_name: 'Sunshine Rentals',
  manager_phone: '+17275551234',
  manager_email: 'manager@example.com',
  alert_channel: 'sms' as const,
  communication_tone: 'professional' as const,
  twilio_phone_number: '+18135559876',
  airbnb_access_token: null,
  airbnb_refresh_token: null,
  vrbo_access_token: null,
  vrbo_refresh_token: null,
  token_version: 1,
  daily_ai_token_usage: 0,
  ai_token_daily_cap: 500000,
  ai_token_cap_reset_at: null,
  data_region: 'us',
  password_hash: 'hash',
  password_reset_token: null,
  password_reset_expires_at: null,
  created_at: new Date(),
} satisfies accounts;

const mockProperty = {
  id: 'prop-001',
  account_id: 'acc-001',
  name: 'Ocean View Cottage',
  address: '123 Beach Road, FL',
  checkin_time: '15:00',
  checkout_time: '11:00',
  door_access_instructions: null,
  parking_instructions: null,
  wifi_name: null,
  wifi_password: null,
  house_rules: null,
  amenities: null,
  local_recommendations: null,
  special_instructions: null,
  checkout_steps: null,
  checkin_message_template: null,
  checkout_reminder_template: null,
  review_request_template: null,
  checkin_message_enabled: true,
  checkout_reminder_enabled: true,
  review_request_enabled: true,
  checkin_message_hours_before: 24,
  checkout_reminder_send_time: '20:00',
  review_request_hours_after: 2,
  airbnb_listing_id: 'airbnb-123',
  vrbo_listing_id: null,
  property_status: 'occupied' as const,
  auto_schedule_cleaner_enabled: true,
  cleaner_confirmation_window_minutes: 60,
  pre_checkin_alert_minutes: 30,
  created_at: new Date(),
} satisfies properties;

const mockBooking = {
  id: 'booking-001',
  account_id: 'acc-001',
  property_id: 'prop-001',
  platform: 'airbnb' as const,
  platform_booking_id: 'airbnb-booking-001',
  guest_first_name: 'Alice',
  guest_last_name: 'Smith',
  guest_platform_id: 'airbnb-user-abc',
  checkin_datetime: new Date(),
  checkout_datetime: new Date(Date.now() + 86400000 * 3),
  status: 'active' as const,
  checkin_message_sent: false,
  checkin_message_sent_at: null,
  checkout_reminder_sent: false,
  checkout_reminder_sent_at: null,
  review_request_sent: false,
  review_request_sent_at: null,
  created_at: new Date(),
} satisfies bookings;

function makeMockMessage(overrides: Partial<messages> = {}): messages {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    account_id: 'acc-001',
    property_id: 'prop-001',
    booking_id: 'booking-001',
    platform_message_id: `plat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    direction: 'inbound',
    channel: 'airbnb',
    sender: 'guest',
    content: 'The AC is not working and it is very hot.',
    intent_classification: null,
    status: 'processing',
    is_urgent: false,
    escalation_reason: null,
    maintenance_triggered: false,
    sent_at: new Date(),
    created_at: new Date(),
    ...overrides,
  } satisfies messages;
}

// ── AC1: createWorkOrderFromAI is exported ───────────────────────────────────
console.log('\nAC1 — createWorkOrderFromAI exported from workOrderCreation.ts');
{
  assert('createWorkOrderFromAI is a function', typeof createWorkOrderFromAI === 'function');
  assert('classifyPriority is exported', typeof classifyPriority === 'function');
  assert('buildGuestAckMessage is exported', typeof buildGuestAckMessage === 'function');
  assert('buildManagerSmsText is exported', typeof buildManagerSmsText === 'function');

  const src = fs.readFileSync(path.join(__dirname, 'workOrderCreation.ts'), 'utf8');
  assert('export async function createWorkOrderFromAI present in source', /export async function createWorkOrderFromAI/.test(src));
}

// ── AC3: Priority classification (PRD Section 8.1) ───────────────────────────
console.log('\nAC3 — Priority classification matches PRD Section 8.1');
{
  // Urgent tier
  assert('urgent: "flood"',          classifyPriority('water is flood everywhere') === 'urgent');
  assert('urgent: "no power"',       classifyPriority('No power in the unit') === 'urgent');
  assert('urgent: "gas smell"',      classifyPriority('I can smell gas smell') === 'urgent');
  assert('urgent: "gas leak"',       classifyPriority('Gas leak under the stove') === 'urgent');
  assert('urgent: "fire"',           classifyPriority('There is a fire in the kitchen') === 'urgent');
  assert('urgent: "smoke"',          classifyPriority('Smoke coming from oven') === 'urgent');
  assert('urgent: "locked out"',     classifyPriority("I'm locked out") === 'urgent');
  assert("urgent: \"can't get in\"", classifyPriority("can't get in the door") === 'urgent');
  assert('urgent: "cannot get in"',  classifyPriority('cannot get in to the property') === 'urgent');
  assert('urgent: "emergency"',      classifyPriority('This is an emergency!') === 'urgent');

  // High tier
  assert('high: "ac not working"',         classifyPriority('ac not working at all') === 'high');
  assert('high: "no ac"',                  classifyPriority('No AC in the bedroom') === 'high');
  assert('high: "air conditioning broken"',classifyPriority('air conditioning broken') === 'high');
  assert('high: "no hot water"',           classifyPriority('no hot water in shower') === 'high');
  assert('high: "heater broken"',          classifyPriority('heater broken') === 'high');
  assert('high: "heat not working"',       classifyPriority('heat not working tonight') === 'high');
  assert("high: \"toilet won't flush\"",   classifyPriority("toilet won't flush") === 'high');
  assert('high: "toilet overflowing"',     classifyPriority('toilet overflowing') === 'high');
  assert('high: "no heat"',               classifyPriority('no heat in the unit') === 'high');

  // Medium tier
  assert('medium: "dishwasher broken"',   classifyPriority('dishwasher broken') === 'medium');
  assert('medium: "oven not working"',    classifyPriority('oven not working') === 'medium');
  assert('medium: "tv not working"',      classifyPriority('tv not working in living room') === 'medium');
  assert('medium: "washer broken"',       classifyPriority('washer broken') === 'medium');
  assert('medium: "dryer broken"',        classifyPriority('dryer broken') === 'medium');
  assert('medium: "light out"',           classifyPriority('light out in bedroom') === 'medium');
  assert('medium: "lightbulb out"',       classifyPriority('lightbulb out') === 'medium');
  assert("medium: \"door won't lock\"",   classifyPriority("door won't lock") === 'medium');
  assert("medium: \"window won't close\"",classifyPriority("window won't close") === 'medium');

  // Low tier
  assert('low: "needs more towels"',  classifyPriority('needs more towels please') === 'low');
  assert('low: "wi-fi slow"',         classifyPriority('wi-fi slow tonight') === 'low');
  assert('low: "slow internet"',      classifyPriority('slow internet connection') === 'low');
  assert('low: "cosmetic issue"',     classifyPriority('cosmetic issue with paint') === 'low');
  assert('low: "minor scratch"',      classifyPriority('minor scratch on table') === 'low');
  assert('low: "needs extra"',        classifyPriority('needs extra pillows') === 'low');
  assert('low: "preference"',         classifyPriority('just a preference') === 'low');

  // Default: medium when no keyword matches
  assert('default → medium',          classifyPriority('something is a bit off') === 'medium');
  assert('default (empty) → medium',  classifyPriority('') === 'medium');

  // Case-insensitive
  assert('case-insensitive: "FIRE"',  classifyPriority('FIRE IN THE HALLWAY') === 'urgent');
  assert('case-insensitive: "NO AC"', classifyPriority('NO AC WORKING') === 'high');

  // Urgent wins over high if both present
  assert('urgent beats high when both match',
    classifyPriority('no power and ac not working') === 'urgent');
}

// ── AC6: Guest acknowledgment template uses ai_summary and business_name ──────
console.log('\nAC6 — Guest acknowledgment template uses {{ai_summary}} and {{business_name}}');
{
  const msg = buildGuestAckMessage('Alice', 'broken AC in bedroom', 'Sunshine Rentals');
  assert('contains guest first name',   msg.includes('Alice'));
  assert('contains ai_summary',         msg.includes('broken AC in bedroom'));
  assert('contains business_name',      msg.includes('Sunshine Rentals'));
  assert('contains acknowledgment text',msg.includes('Our team has been notified'));
  assert('contains patience text',      msg.includes('We appreciate your patience'));

  // No hardcoded business name in source
  const src = fs.readFileSync(path.join(__dirname, 'workOrderCreation.ts'), 'utf8');
  assert('business_name variable used in guest ack (not hardcoded)', /businessName/.test(src));
}

// ── AC7 (partial): manager SMS text uses correct template ─────────────────────
console.log('\nAC7 (template) — Manager SMS text uses PRD Section 8.2 template');
{
  const sms = buildManagerSmsText('URGENT', 'Ocean View Cottage', 'flooding in bathroom', 'Sunshine Rentals');
  assert('SMS contains MAINTENANCE prefix',        sms.includes('MAINTENANCE URGENT'));
  assert('SMS contains property name',             sms.includes('Ocean View Cottage'));
  assert('SMS contains ai_summary',               sms.includes('flooding in bathroom'));
  assert('SMS contains Reported by: Guest',        sms.includes('Reported by: Guest'));
  assert('SMS contains "Work order logged"',       sms.includes('Work order logged'));
  assert('SMS contains business_name',             sms.includes('Sunshine Rentals'));
  assert('SMS does NOT hardcode app name "VRM"',   !sms.includes('VRM Agent'));
}

// ── AC2 + AC4 + AC5 + AC7 + AC8: integration with mocked I/O ─────────────────
// These tests use dep-injection overrides to verify behavior without real DB/API.

(async () => {

  // ── AC4: work order row inserted with correct fields ─────────────────────────
  console.log('\nAC4 — work_orders row inserted with reported_by=guest, status=open, source_message_id set');
  {
    const sentToGuest: string[] = [];
    const sentSms: string[] = [];
    let maintenanceTriggered = false;
    let workOrderCreated: Record<string, unknown> | null = null;

    // Patch prisma methods for this test only
    const origCreate = (prisma.work_orders as any).create;
    const origMsgUpdate = (prisma.messages as any).update;

    (prisma.work_orders as any).create = async (args: any) => {
      workOrderCreated = args.data;
      return { id: 'wo-test-001' };
    };
    (prisma.messages as any).update = async (args: any) => {
      if (args.data.maintenance_triggered === true) maintenanceTriggered = true;
      return {};
    };

    const input: CreateWorkOrderInput = {
      account: mockAccount,
      property: mockProperty,
      booking: mockBooking,
      sourceMessage: makeMockMessage({ content: 'ac not working in bedroom' }),
      maintenanceDescription: 'Air conditioning unit is not cooling',
    };

    const result = await createWorkOrderFromAI(input, {
      sendPlatformMessageFn: async (_, __, text) => { sentToGuest.push(text); },
      sendSmsFn: async (_, __, text) => { sentSms.push(text); },
      aiCallFn: async () => 'AC unit not cooling in bedroom',
    });

    // Restore
    (prisma.work_orders as any).create = origCreate;
    (prisma.messages as any).update = origMsgUpdate;

    assert('AC4: outcome is work_order_created', result.outcome === 'work_order_created');
    assert('AC4: reported_by = "guest"',         workOrderCreated?.['reported_by'] === 'guest');
    assert('AC4: status = "open"',               workOrderCreated?.['status'] === 'open');
    assert('AC4: source_message_id set',         typeof workOrderCreated?.['source_message_id'] === 'string');
    assert('AC4: account_id set',                workOrderCreated?.['account_id'] === 'acc-001');
    assert('AC4: property_id set',               workOrderCreated?.['property_id'] === 'prop-001');
  }

  // ── AC8: messages.maintenance_triggered = true ────────────────────────────────
  console.log('\nAC8 — messages.maintenance_triggered = true set after processing');
  {
    let maintenanceTriggered = false;
    let updateArgs: Record<string, unknown> | null = null;

    const origCreate = (prisma.work_orders as any).create;
    const origMsgUpdate = (prisma.messages as any).update;

    (prisma.work_orders as any).create = async () => ({ id: 'wo-test-002' });
    (prisma.messages as any).update = async (args: any) => {
      updateArgs = args;
      if (args.data?.maintenance_triggered === true) maintenanceTriggered = true;
      return {};
    };

    const mockMsg = makeMockMessage({ id: 'msg-ac8-test', content: 'dishwasher broken' });

    await createWorkOrderFromAI(
      {
        account: mockAccount,
        property: mockProperty,
        booking: mockBooking,
        sourceMessage: mockMsg,
        maintenanceDescription: 'Dishwasher stopped mid-cycle',
      },
      {
        sendPlatformMessageFn: async () => {},
        sendSmsFn: async () => {},
        aiCallFn: async () => 'Dishwasher stopped mid-cycle',
      },
    );

    (prisma.work_orders as any).create = origCreate;
    (prisma.messages as any).update = origMsgUpdate;

    assert('AC8: maintenance_triggered = true set',   maintenanceTriggered);
    assert('AC8: update targets correct message id',  updateArgs?.['where']?.['id'] === 'msg-ac8-test');
  }

  // ── AC2: Empty description → ESCALATE path, no work_orders row ───────────────
  console.log('\nAC2 — Empty maintenanceDescription → ESCALATE path; no work_orders row created');
  {
    let workOrderInserted = false;
    const sentToGuest: string[] = [];
    const sentSms: string[] = [];
    let statusUpdated: string | null = null;

    const origCreate = (prisma.work_orders as any).create;
    const origMsgUpdate = (prisma.messages as any).update;

    (prisma.work_orders as any).create = async () => {
      workOrderInserted = true;
      return { id: 'should-not-be-created' };
    };
    (prisma.messages as any).update = async (args: any) => {
      if (args.data?.status) statusUpdated = args.data.status;
      return {};
    };

    const result = await createWorkOrderFromAI(
      {
        account: mockAccount,
        property: mockProperty,
        booking: mockBooking,
        sourceMessage: makeMockMessage({ content: 'MAINTENANCE:' }),
        maintenanceDescription: '',   // ← empty
      },
      {
        sendPlatformMessageFn: async (_, __, text) => { sentToGuest.push(text); },
        sendSmsFn: async (_, __, text) => { sentSms.push(text); },
        aiCallFn: async () => { throw new Error('should not be called'); },
      },
    );

    assert('AC2: outcome is "escalated"',            result.outcome === 'escalated');
    assert('AC2: reason is empty_description',       result.outcome === 'escalated' && (result as any).reason === 'empty_description');
    assert('AC2: no work_orders row created',        !workOrderInserted);
    assert('AC2: guest holding message sent',        sentToGuest.length === 1);
    assert('AC2: holding message has guest name',    sentToGuest[0]?.includes('Alice'));
    assert('AC2: holding message has correct text',  sentToGuest[0]?.includes('let me check on that'));
    assert('AC2: manager escalation alert sent',     sentSms.length === 1);
    assert('AC2: manager alert has ESCALATED label', sentSms[0]?.includes('QUESTION ESCALATED'));
    assert('AC2: manager alert has property name',   sentSms[0]?.includes('Ocean View Cottage'));
    assert('AC2: message status set to escalated',   statusUpdated === 'escalated');

    // Also test whitespace-only description — mocks are still active here
    workOrderInserted = false;
    const result2 = await createWorkOrderFromAI(
      {
        account: mockAccount,
        property: mockProperty,
        booking: mockBooking,
        sourceMessage: makeMockMessage({ content: 'MAINTENANCE:   ' }),
        maintenanceDescription: '   ',  // whitespace only
      },
      {
        sendPlatformMessageFn: async () => {},
        sendSmsFn: async () => {},
        aiCallFn: async () => { throw new Error('should not be called'); },
      },
    );

    // Restore after both sub-tests complete
    (prisma.work_orders as any).create = origCreate;
    (prisma.messages as any).update = origMsgUpdate;

    assert('AC2: whitespace-only description also escalates', result2.outcome === 'escalated');
    assert('AC2: no work_orders row for whitespace description', !workOrderInserted);
  }

  // ── AC5: Duplicate source_message_id → handled silently ──────────────────────
  console.log('\nAC5 — Duplicate source_message_id → unique constraint handled silently');
  {
    const sentToGuest: string[] = [];
    let maintenanceTriggered = false;

    const origCreate = (prisma.work_orders as any).create;
    const origMsgUpdate = (prisma.messages as any).update;

    // Simulate Prisma P2002 unique constraint error
    (prisma.work_orders as any).create = async () => {
      const err = new Error('Unique constraint failed on the fields: (`source_message_id`)');
      (err as any).code = 'P2002';
      throw err;
    };
    (prisma.messages as any).update = async (args: any) => {
      if (args.data?.maintenance_triggered === true) maintenanceTriggered = true;
      return {};
    };

    let threw = false;
    try {
      const result = await createWorkOrderFromAI(
        {
          account: mockAccount,
          property: mockProperty,
          booking: mockBooking,
          sourceMessage: makeMockMessage({ content: 'AC not working' }),
          maintenanceDescription: 'AC is not cooling',
        },
        {
          sendPlatformMessageFn: async (_, __, text) => { sentToGuest.push(text); },
          sendSmsFn: async () => {},
          aiCallFn: async () => 'AC is not cooling',
        },
      );
      assert('AC5: outcome is duplicate_skipped', result.outcome === 'duplicate_skipped');
    } catch {
      threw = true;
    }

    (prisma.work_orders as any).create = origCreate;
    (prisma.messages as any).update = origMsgUpdate;

    assert('AC5: function does not throw on P2002',         !threw);
    assert('AC5: guest acknowledgment still sent',          sentToGuest.length === 1);
    assert('AC5: maintenance_triggered still set to true',  maintenanceTriggered);
  }

  // ── AC7: Manager SMS sent for Urgent + High only ──────────────────────────────
  console.log('\nAC7 — Manager SMS sent for Urgent and High priority only');
  {
    const priorities: WorkOrderPriority[] = ['urgent', 'high', 'medium', 'low'];
    const rawMessages: Record<WorkOrderPriority, string> = {
      urgent:  'no power in the unit',
      high:    'ac not working',
      medium:  'dishwasher broken',
      low:     'needs more towels',
    };
    const smsShouldBeSent: Record<WorkOrderPriority, boolean> = {
      urgent: true,
      high:   true,
      medium: false,
      low:    false,
    };

    for (const priority of priorities) {
      const smsCalls: string[] = [];

      const origCreate = (prisma.work_orders as any).create;
      const origMsgUpdate = (prisma.messages as any).update;

      (prisma.work_orders as any).create = async () => ({ id: `wo-${priority}` });
      (prisma.messages as any).update = async () => ({});

      await createWorkOrderFromAI(
        {
          account: mockAccount,
          property: mockProperty,
          booking: mockBooking,
          sourceMessage: makeMockMessage({ content: rawMessages[priority] }),
          maintenanceDescription: 'some issue description',
        },
        {
          sendPlatformMessageFn: async () => {},
          sendSmsFn: async (_, __, text) => { smsCalls.push(text); },
          aiCallFn: async () => 'issue summary',
        },
      );

      (prisma.work_orders as any).create = origCreate;
      (prisma.messages as any).update = origMsgUpdate;

      const expected = smsShouldBeSent[priority];
      assert(
        `AC7: priority=${priority} — SMS ${expected ? 'sent' : 'NOT sent'}`,
        expected ? smsCalls.length > 0 : smsCalls.length === 0,
      );

      if (expected && smsCalls.length > 0) {
        const smsText = smsCalls[0];
        assert(`AC7: SMS for ${priority} contains MAINTENANCE prefix`, smsText.includes('MAINTENANCE'));
        assert(`AC7: SMS for ${priority} contains priority label`, smsText.toUpperCase().includes(priority.toUpperCase()));
        assert(`AC7: SMS uses business_name, not hardcoded`, smsText.includes(mockAccount.business_name));
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
