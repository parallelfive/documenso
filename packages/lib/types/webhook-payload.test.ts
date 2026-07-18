import { WebhookTriggerEvents } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { isBizBuddyExternalId, isValidBizBuddyExternalId } from '../constants/app';
import {
  MAX_BIZBUDDY_WEBHOOK_RECIPIENTS,
  MAX_NATIVE_WEBHOOK_RECIPIENTS,
  getSafeWebhookResendData,
  projectWebhookCallEvidence,
  projectWebhookLifecycleDocument,
} from './webhook-payload';

const safeRecipient = {
  id: 101,
  role: 'SIGNER',
  readStatus: 'OPENED',
  signingStatus: 'SIGNED',
  sendStatus: 'SENT',
  signedAt: '2026-07-17T14:00:00.000Z',
  expiresAt: '2026-07-24T14:00:00.000Z',
};

const safeDocument = {
  id: 42,
  externalId: 'bizbuddy:11111111-1111-4111-8111-111111111111',
  status: 'COMPLETED',
  createdAt: '2026-07-16T14:00:00.000Z',
  updatedAt: '2026-07-17T14:00:00.000Z',
  completedAt: '2026-07-17T14:00:00.000Z',
  deletedAt: null,
  recipients: [safeRecipient],
};

describe('safe webhook manual resend data', () => {
  it('replays new evidence without adding fields', () => {
    const evidence = projectWebhookCallEvidence({
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      payload: safeDocument,
      createdAt: '2026-07-17T14:01:00.000Z',
    });

    expect(getSafeWebhookResendData(evidence)).toEqual(safeDocument);
  });

  it('projects signing capabilities out of legacy full-body rows before enqueue', () => {
    const legacyRecipient = {
      ...safeDocument.recipients[0],
      documentId: 42,
      templateId: null,
      email: 'signer@example.test',
      name: 'Sensitive Signer',
      token: 'legacy-live-capability',
      documentDeletedAt: null,
      expirationNotifiedAt: null,
      authOptions: { token: 'legacy-auth-capability' },
      signingOrder: 1,
      rejectionReason: null,
    };
    const legacy = {
      event: WebhookTriggerEvents.DOCUMENT_COMPLETED,
      payload: {
        ...safeDocument,
        userId: 7,
        authOptions: { token: 'document-auth-capability' },
        formValues: { answer: 'private-form-value' },
        visibility: 'EVERYONE',
        title: 'Sensitive title',
        teamId: 9,
        templateId: null,
        source: 'DOCUMENT',
        documentMeta: null,
        recipients: [legacyRecipient],
        Recipient: [legacyRecipient],
      },
      createdAt: '2026-07-17T14:01:00.000Z',
      webhookEndpoint: 'https://example.test/webhook',
    };

    const result = getSafeWebhookResendData(legacy);

    expect(result).toEqual(safeDocument);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('legacy-live-capability');
    expect(serialized).not.toContain('legacy-auth-capability');
    expect(serialized).not.toContain('document-auth-capability');
    expect(serialized).not.toContain('private-form-value');
    expect(serialized).not.toContain('signer@example.test');
  });
});

describe('strict webhook lifecycle projection', () => {
  const recipients = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...safeRecipient,
      id: index + 1,
    }));

  it(`accepts ${MAX_BIZBUDDY_WEBHOOK_RECIPIENTS} Biz Buddy recipients`, () => {
    expect(
      projectWebhookLifecycleDocument({
        ...safeDocument,
        recipients: recipients(MAX_BIZBUDDY_WEBHOOK_RECIPIENTS),
      }).recipients,
    ).toHaveLength(MAX_BIZBUDDY_WEBHOOK_RECIPIENTS);
  });

  it(`rejects ${MAX_BIZBUDDY_WEBHOOK_RECIPIENTS + 1} Biz Buddy recipients`, () => {
    expect(() =>
      projectWebhookLifecycleDocument({
        ...safeDocument,
        recipients: recipients(MAX_BIZBUDDY_WEBHOOK_RECIPIENTS + 1),
      }),
    ).toThrow();
  });

  it(`accepts ${MAX_NATIVE_WEBHOOK_RECIPIENTS} native recipients`, () => {
    expect(
      projectWebhookLifecycleDocument({
        ...safeDocument,
        externalId: 'native-document-reference',
        recipients: recipients(MAX_NATIVE_WEBHOOK_RECIPIENTS),
      }).recipients,
    ).toHaveLength(MAX_NATIVE_WEBHOOK_RECIPIENTS);
  });

  it(`rejects ${MAX_NATIVE_WEBHOOK_RECIPIENTS + 1} native recipients`, () => {
    expect(() =>
      projectWebhookLifecycleDocument({
        ...safeDocument,
        externalId: 'native-document-reference',
        recipients: recipients(MAX_NATIVE_WEBHOOK_RECIPIENTS + 1),
      }),
    ).toThrow();
  });

  it.each([
    'bizbuddy:11111111-1111-4111-8111-111111111111',
    'bizbuddy:01890f47-6e3d-7b71-bc43-111111111111',
    'bizbuddy:01890f47-6e3d-8b71-bc43-111111111111',
  ])('uses the canonical validator consistently for supported UUID versions: %s', (externalId) => {
    expect(isValidBizBuddyExternalId(externalId)).toBe(true);
    expect(() =>
      projectWebhookLifecycleDocument({
        ...safeDocument,
        externalId,
      }),
    ).not.toThrow();
  });

  it.each([
    'bizbuddy:not-a-uuid',
    'BIZBUDDY:11111111-1111-4111-8111-111111111111',
    'bizbuddy:11111111-1111-4111-8111-11111111111Z',
  ])('rejects every classified but non-canonical Biz Buddy ID consistently: %s', (externalId) => {
    expect(isBizBuddyExternalId(externalId)).toBe(true);
    expect(isValidBizBuddyExternalId(externalId)).toBe(false);
    expect(() =>
      projectWebhookLifecycleDocument({
        ...safeDocument,
        externalId,
      }),
    ).toThrow();
  });

  it.each([
    {
      label: 'malformed reserved namespace',
      patch: { externalId: 'bizbuddy:not-a-uuid' },
    },
    {
      label: 'oversized external id',
      patch: { externalId: 'x'.repeat(257) },
    },
    {
      label: 'unknown document status',
      patch: { status: 'TERMINAL_BUT_UNKNOWN' },
    },
    {
      label: 'invalid timestamp',
      patch: { updatedAt: 'tomorrow-ish' },
    },
    {
      label: 'non-positive document id',
      patch: { id: 0 },
    },
  ])('rejects $label', ({ patch }) => {
    expect(() => projectWebhookLifecycleDocument({ ...safeDocument, ...patch })).toThrow();
  });

  it('rejects unknown recipient enums instead of silently weakening them to null', () => {
    expect(() =>
      projectWebhookLifecycleDocument({
        ...safeDocument,
        recipients: [{ ...safeRecipient, signingStatus: 'MAYBE_SIGNED' }],
      }),
    ).toThrow();
  });

  it('rejects invalid or duplicate recipients instead of silently dropping them', () => {
    for (const invalidRecipients of [
      [safeRecipient, { ...safeRecipient, id: 0 }],
      [safeRecipient, { ...safeRecipient }],
      [safeRecipient, null],
    ]) {
      expect(() =>
        projectWebhookLifecycleDocument({
          ...safeDocument,
          recipients: invalidRecipients,
        }),
      ).toThrow();
    }
  });

  it('omits signer-authored rejection text from lifecycle data', () => {
    const projected = projectWebhookLifecycleDocument({
      ...safeDocument,
      recipients: [{ ...safeRecipient, rejectionReason: 'private signer-authored text' }],
    });

    expect(projected.recipients[0]).not.toHaveProperty('rejectionReason');
    expect(JSON.stringify(projected)).not.toContain('private signer-authored text');
  });
});
