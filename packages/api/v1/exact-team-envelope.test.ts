import { EnvelopeType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { exactTeamApiEnvelopeSelect, getExactTeamApiEnvelope } from './exact-team-envelope';

const documentOperations = [
  'get document',
  'get download URL',
  'delete document',
  'send document',
  'resend document',
  'create recipient',
  'update recipient',
  'delete recipient',
  'create field',
  'update field',
  'delete field',
] as const;

const templateOperations = [
  'get template',
  'delete template',
  'create document from template',
  'generate document from template',
] as const;

describe('getExactTeamApiEnvelope', () => {
  it.each([
    ...documentOperations.map((operation) => ({
      operation,
      type: EnvelopeType.DOCUMENT,
      id: { type: 'documentId' as const, id: 42 },
    })),
    ...templateOperations.map((operation) => ({
      operation,
      type: EnvelopeType.TEMPLATE,
      id: { type: 'templateId' as const, id: 42 },
    })),
  ])('denies cross-team owner access for $operation', async ({ type, id }) => {
    const ownerOrTeamWhere = {
      secondaryId: `${id.type === 'documentId' ? 'document' : 'template'}_42`,
      OR: [{ userId: 7 }, { teamId: 9 }],
    };
    const findEnvelope = vi.fn().mockResolvedValue(null);

    const result = await getExactTeamApiEnvelope(
      {
        id,
        type,
        userId: 7,
        teamId: 9,
      },
      {
        getWhere: vi.fn().mockResolvedValue({
          envelopeWhereInput: ownerOrTeamWhere,
          team: { id: 9 },
        }),
        findEnvelope,
      },
    );

    expect(result).toBeNull();
    expect(findEnvelope).toHaveBeenCalledWith(
      {
        AND: [ownerOrTeamWhere, { teamId: 9, type }],
      },
      exactTeamApiEnvelopeSelect,
    );
  });

  it('repeats the exact-team check after the database query', async () => {
    const result = await getExactTeamApiEnvelope(
      {
        id: {
          type: 'documentId',
          id: 42,
        },
        type: EnvelopeType.DOCUMENT,
        userId: 7,
        teamId: 9,
      },
      {
        getWhere: vi.fn().mockResolvedValue({
          envelopeWhereInput: { OR: [{ userId: 7 }, { teamId: 9 }] },
          team: { id: 9 },
        }),
        findEnvelope: vi.fn().mockResolvedValue({
          id: 'envelope_cross_team',
          secondaryId: 'document_42',
          teamId: 99,
        }),
      },
    );

    expect(result).toBeNull();
  });

  it('returns only the capability-minimal exact-team reference', async () => {
    const envelope = {
      id: 'envelope_exact_team',
      secondaryId: 'document_42',
      teamId: 9,
    };

    const result = await getExactTeamApiEnvelope(
      {
        id: {
          type: 'documentId',
          id: 42,
        },
        type: EnvelopeType.DOCUMENT,
        userId: 7,
        teamId: 9,
      },
      {
        getWhere: vi.fn().mockResolvedValue({
          envelopeWhereInput: { secondaryId: 'document_42' },
          team: { id: 9 },
        }),
        findEnvelope: vi.fn().mockResolvedValue(envelope),
      },
    );

    expect(result).toEqual(envelope);
    expect(Object.keys(exactTeamApiEnvelopeSelect).sort()).toEqual(['id', 'secondaryId', 'teamId']);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid legacy id %s before querying',
    async (legacyId) => {
      const getWhere = vi.fn();
      const findEnvelope = vi.fn();

      const result = await getExactTeamApiEnvelope(
        {
          id: {
            type: 'documentId',
            id: legacyId,
          },
          type: EnvelopeType.DOCUMENT,
          userId: 7,
          teamId: 9,
        },
        {
          getWhere,
          findEnvelope,
        },
      );

      expect(result).toBeNull();
      expect(getWhere).not.toHaveBeenCalled();
      expect(findEnvelope).not.toHaveBeenCalled();
    },
  );
});
