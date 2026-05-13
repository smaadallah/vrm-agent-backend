/**
 * T-048 — Feature 3.2 — Review Response Draft Worker
 *
 * Processes Airbnb and VRBO review events.
 * Deduplicates on platform_review_id, generates AI draft,
 * inserts review_drafts row with status = 'pending', notifies manager.
 * booking_id is always NULL in MVP.
 */

import Anthropic from '@anthropic-ai/sdk';
import prisma from '../lib/prisma';
import logger from '../lib/logger';
import { sendManagerSms } from './workOrderCreation';

// ── Injectable hooks for testing ──────────────────────────────────────────────

export const _hooks = {
  smsSend: undefined as ((to: string, from: string, body: string) => Promise<void>) | undefined,
  aiCall:  undefined as ((prompt: string) => Promise<string>) | undefined,
};

// ── Payload interface ─────────────────────────────────────────────────────────

export interface ReviewPayload {
  platform_review_id: string;
  listing_id:         string;
  reviewer_name:      string;
  rating:             number;
  review_text?:       string | null;
  timestamp?:         string;
}

// ── Template builders ─────────────────────────────────────────────────────────

export function buildStaticFallback(
  propertyName:  string,
  reviewerName:  string,
  businessName:  string,
): string {
  return (
    `Thank you so much for staying at ${propertyName} and for taking the time to leave a review, ${reviewerName}!\n` +
    `We hope you enjoyed your stay and would love to welcome you back.\n` +
    businessName
  );
}

export function buildManagerNotification(
  reviewerName:  string,
  rating:        number,
  propertyName:  string,
  businessName:  string,
): string {
  return (
    `NEW REVIEW: ${reviewerName} left a ${rating}-star review at ${propertyName}.\n` +
    `Draft response is ready in VRM Agent. Log in to review and post.\n` +
    `- ${businessName}`
  );
}

export function buildPositivePrompt(
  businessName:  string,
  tone:          string,
  propertyName:  string,
  reviewerName:  string,
  rating:        number,
  reviewText:    string,
): string {
  return (
    `You are drafting a review response on behalf of ${businessName}.\n` +
    `Your tone is ${tone}.\n` +
    `Property: ${propertyName}\n` +
    `Reviewer name: ${reviewerName}\n` +
    `Star rating: ${rating} out of 5\n` +
    `Review text: ${reviewText}\n\n` +
    `Write a warm, genuine response. Keep it under 150 words.\n` +
    `Rules:\n` +
    `1. Address the reviewer by first name if determinable; otherwise use full name.\n` +
    `2. Thank them sincerely for their stay and for taking the time to review.\n` +
    `3. Reference one specific detail from the review if possible. Do not invent details.\n` +
    `4. Invite them to return.\n` +
    `5. Sign off with ${businessName}.\n` +
    `6. Never fabricate information not present in the review text.`
  );
}

export function buildNegativePrompt(
  businessName:  string,
  tone:          string,
  propertyName:  string,
  reviewerName:  string,
  rating:        number,
  reviewText:    string,
): string {
  return (
    `You are drafting a review response on behalf of ${businessName}.\n` +
    `Your tone is ${tone}.\n` +
    `Property: ${propertyName}\n` +
    `Reviewer name: ${reviewerName}\n` +
    `Star rating: ${rating} out of 5\n` +
    `Review text: ${reviewText}\n\n` +
    `Write a professional, constructive response. Keep it under 150 words.\n` +
    `Rules:\n` +
    `1. Address the reviewer by first name if determinable; otherwise use full name.\n` +
    `2. Thank them for their feedback.\n` +
    `3. Acknowledge their experience without being defensive.\n` +
    `4. Apologize briefly and professionally for any shortcoming they described.\n` +
    `5. Use general language about addressing feedback. Do not make specific promises. Never promise refunds or compensation.\n` +
    `6. Invite them to contact ${businessName} directly to discuss further.\n` +
    `7. Sign off with ${businessName}.\n` +
    `8. Never fabricate information not in the review text.`
  );
}

// ── AI call ───────────────────────────────────────────────────────────────────

async function defaultAiCall(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model:     'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages:  [{ role: 'user', content: prompt }],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error('Unexpected AI response type');
  return block.text.trim();
}

// ── Core handler ──────────────────────────────────────────────────────────────

async function processReview(
  platform: 'airbnb' | 'vrbo',
  job: { data: unknown },
): Promise<void> {
  const payload = job.data as ReviewPayload;
  const { platform_review_id, listing_id, reviewer_name, rating, review_text } = payload;

  // 1. Dedup — discard if already processed
  const existing = await prisma.review_drafts.findUnique({
    where:  { platform_review_id },
    select: { id: true },
  });
  if (existing) {
    logger.info({ platform_review_id }, 'review already processed — discarding');
    return;
  }

  // 2. Property lookup
  const listingField = platform === 'airbnb' ? 'airbnb_listing_id' : 'vrbo_listing_id';
  const property = await prisma.properties.findFirst({
    where:   { [listingField]: listing_id },
    include: { account: true },
  });
  if (!property) {
    logger.warn({ platform, listing_id }, 'no property found for listing_id — discarding review');
    return;
  }

  const { account } = property as typeof property & { account: { id: string; business_name: string; manager_phone: string; twilio_phone_number: string | null; alert_channel: string; communication_tone: string } };

  const isEmpty = !review_text || review_text.trim() === '';

  let draft_response: string | null;
  let no_review_text = false;
  let ai_failed      = false;

  if (isEmpty) {
    // 3. Static fallback — no AI call
    draft_response = buildStaticFallback(property.name, reviewer_name, account.business_name);
    no_review_text = true;
  } else {
    // 4-5. Rating classification → AI prompt
    const aiPrompt = rating >= 4
      ? buildPositivePrompt(account.business_name, account.communication_tone, property.name, reviewer_name, rating, review_text!)
      : buildNegativePrompt(account.business_name, account.communication_tone, property.name, reviewer_name, rating, review_text!);

    const callFn = _hooks.aiCall ?? defaultAiCall;

    // 6. AI call with 10s timeout; on failure → null draft, ai_failed = true
    try {
      draft_response = await Promise.race([
        callFn(aiPrompt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AI review draft timeout')), 10_000),
        ),
      ]);
    } catch (err) {
      logger.warn({ err }, 'AI review draft generation failed — storing null draft');
      draft_response = null;
      ai_failed      = true;
    }
  }

  // 7. INSERT review_drafts — booking_id always null in MVP
  await prisma.review_drafts.create({
    data: {
      account_id:         account.id,
      property_id:        property.id,
      booking_id:         null,
      platform,
      platform_review_id,
      reviewer_name,
      rating,
      review_text:        review_text ?? null,
      draft_response,
      status:             'pending',
      no_review_text,
      ai_failed,
    },
  });

  // 8. Manager notification via alert_channel
  const notificationText = buildManagerNotification(reviewer_name, rating, property.name, account.business_name);
  await sendManagerSms(account as Parameters<typeof sendManagerSms>[0], notificationText, _hooks.smsSend ?? undefined).catch(
    (err: unknown) => logger.error({ err }, 'review draft manager notification failed'),
  );
}

// ── Exported webhook handlers ─────────────────────────────────────────────────

export async function processAirbnbReviewHandler(job: { data: unknown }): Promise<void> {
  return processReview('airbnb', job);
}

export async function processVrboReviewHandler(job: { data: unknown }): Promise<void> {
  return processReview('vrbo', job);
}
