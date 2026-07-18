import { DocumentStatus, EnvelopeType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { withDocumentDraftMutationGuard } from './with-document-draft-mutation-guard';

const createStatefulTransaction = (
  initialStatus: DocumentStatus,
  initialExternalId = 'bizbuddy:envelope_01',
  initialRecipientCount = 0,
) => {
  let status = initialStatus;
  let externalId = initialExternalId;
  let recipientCount = initialRecipientCount;

  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: {
        id: string;
        teamId: number;
        type: EnvelopeType;
        status: DocumentStatus;
        externalId?: string;
        recipients?: {
          none: Record<string, never>;
        };
      };
      data: { status: DocumentStatus };
    }) => {
      await Promise.resolve();

      if (
        where.id !== 'envelope_01' ||
        where.teamId !== 9 ||
        where.type !== EnvelopeType.DOCUMENT ||
        status !== where.status ||
        (where.externalId !== undefined && externalId !== where.externalId) ||
        (where.recipients?.none !== undefined && recipientCount !== 0)
      ) {
        return { count: 0 };
      }

      status = data.status;
      return { count: 1 };
    },
  );

  return {
    tx: { envelope: { updateMany } },
    updateMany,
    getStatus: () => status,
    setExternalId: (value: string) => {
      externalId = value;
    },
    setRecipientCount: (value: number) => {
      recipientCount = value;
    },
  };
};

const guardOptions = {
  envelopeId: 'envelope_01',
  teamId: 9,
};

describe('withDocumentDraftMutationGuard', () => {
  it('holds the draft lock while a field mutation runs', async () => {
    const { tx, getStatus } = createStatefulTransaction(DocumentStatus.DRAFT);
    const createField = vi.fn().mockResolvedValue('field_01');

    await expect(
      withDocumentDraftMutationGuard({ ...guardOptions, tx }, createField),
    ).resolves.toBe('field_01');

    expect(createField).toHaveBeenCalledTimes(1);
    expect(getStatus()).toBe(DocumentStatus.DRAFT);
  });

  it.each([DocumentStatus.PENDING, DocumentStatus.COMPLETED, DocumentStatus.REJECTED])(
    'does not mutate fields after a concurrent transition to %s',
    async (status) => {
      const { tx, getStatus } = createStatefulTransaction(status);
      const createField = vi.fn().mockResolvedValue('field_01');

      await expect(
        withDocumentDraftMutationGuard({ ...guardOptions, tx }, createField),
      ).rejects.toMatchObject({
        code: AppErrorCode.CONFLICT,
      });

      expect(createField).not.toHaveBeenCalled();
      expect(getStatus()).toBe(status);
    },
  );

  it('allows only one concurrent send claim and never reopens the pending document', async () => {
    const { tx, getStatus } = createStatefulTransaction(DocumentStatus.DRAFT);
    const firstSend = vi.fn().mockResolvedValue('sent');
    const secondSend = vi.fn().mockResolvedValue('sent-again');

    await expect(
      withDocumentDraftMutationGuard({ ...guardOptions, tx, transitionToPending: true }, firstSend),
    ).resolves.toBe('sent');

    await expect(
      withDocumentDraftMutationGuard(
        { ...guardOptions, tx, transitionToPending: true },
        secondSend,
      ),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).not.toHaveBeenCalled();
    expect(getStatus()).toBe(DocumentStatus.PENDING);
  });

  it.each([DocumentStatus.COMPLETED, DocumentStatus.REJECTED])(
    'does not overwrite terminal %s during a send race',
    async (status) => {
      const { tx, getStatus } = createStatefulTransaction(status);
      const send = vi.fn().mockResolvedValue('sent');

      await expect(
        withDocumentDraftMutationGuard({ ...guardOptions, tx, transitionToPending: true }, send),
      ).rejects.toMatchObject({
        code: AppErrorCode.CONFLICT,
      });

      expect(send).not.toHaveBeenCalled();
      expect(getStatus()).toBe(status);
    },
  );

  it('rejects a correlated mutation if its external identity changes before the draft lock', async () => {
    const { tx, setExternalId, updateMany } = createStatefulTransaction(DocumentStatus.DRAFT);
    const mutate = vi.fn().mockResolvedValue('mutated');

    setExternalId('native-document');

    await expect(
      withDocumentDraftMutationGuard(
        {
          ...guardOptions,
          tx,
          expectedExternalId: 'bizbuddy:envelope_01',
        },
        mutate,
      ),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'envelope_01',
        teamId: 9,
        type: EnvelopeType.DOCUMENT,
        status: DocumentStatus.DRAFT,
        externalId: 'bizbuddy:envelope_01',
      },
      data: {
        status: DocumentStatus.DRAFT,
      },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('atomically rejects initial recipient population if another writer populated recipients', async () => {
    const { tx, setRecipientCount, updateMany } = createStatefulTransaction(DocumentStatus.DRAFT);
    const populateRecipients = vi.fn().mockResolvedValue('populated');

    setRecipientCount(1);

    await expect(
      withDocumentDraftMutationGuard(
        {
          ...guardOptions,
          tx,
          expectedExternalId: 'bizbuddy:envelope_01',
          requireNoRecipients: true,
        },
        populateRecipients,
      ),
    ).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'envelope_01',
        teamId: 9,
        type: EnvelopeType.DOCUMENT,
        status: DocumentStatus.DRAFT,
        externalId: 'bizbuddy:envelope_01',
        recipients: {
          none: {},
        },
      },
      data: {
        status: DocumentStatus.DRAFT,
      },
    });
    expect(populateRecipients).not.toHaveBeenCalled();
  });
});
