import { describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';

import type { ApiDocumentEnvelope } from './get-document';
import { getExactTeamApiDocument } from './get-document';

const envelopeForTeam = (teamId: number): ApiDocumentEnvelope => {
  // Only teamId is read by the authorization helper; the production
  // dependency supplies the complete typed include graph.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { teamId } as ApiDocumentEnvelope;
};

describe('getExactTeamApiDocument', () => {
  it('fetches the full response only after the capability-minimal guard succeeds', async () => {
    const findEnvelope = vi.fn().mockResolvedValue(envelopeForTeam(9));

    const result = await getExactTeamApiDocument(
      { documentId: 42, userId: 7, teamId: 9 },
      {
        guardDocument: vi.fn().mockResolvedValue({
          id: 'envelope_42',
          secondaryId: 'document_42',
          teamId: 9,
        }),
        findEnvelope,
      },
    );

    expect(result.status).toBe(200);
    expect(findEnvelope).toHaveBeenCalledWith('envelope_42', 9);
  });

  it('does not fetch capabilities when the exact-team guard denies access', async () => {
    const findEnvelope = vi.fn();
    const result = await getExactTeamApiDocument(
      { documentId: 42, userId: 7, teamId: 9 },
      {
        guardDocument: vi.fn().mockResolvedValue(null),
        findEnvelope,
      },
    );

    expect(result).toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
    expect(findEnvelope).not.toHaveBeenCalled();
  });

  it('denies a full document returned from another token team', async () => {
    const result = await getExactTeamApiDocument(
      { documentId: 42, userId: 7, teamId: 9 },
      {
        guardDocument: vi.fn().mockResolvedValue({
          id: 'envelope_42',
          secondaryId: 'document_42',
          teamId: 9,
        }),
        findEnvelope: vi.fn().mockResolvedValue(envelopeForTeam(99)),
      },
    );

    expect(result).toEqual({
      status: 404,
      body: { message: 'Document not found' },
    });
  });

  it('maps only expected denial/not-found errors to 404', async () => {
    for (const code of [AppErrorCode.NOT_FOUND, AppErrorCode.UNAUTHORIZED]) {
      const result = await getExactTeamApiDocument(
        { documentId: 42, userId: 7, teamId: 9 },
        {
          guardDocument: vi.fn().mockRejectedValue(new AppError(code)),
          findEnvelope: vi.fn(),
        },
      );

      expect(result).toEqual({
        status: 404,
        body: { message: 'Document not found' },
      });
    }
  });

  it('preserves internal lookup failures as 500', async () => {
    const result = await getExactTeamApiDocument(
      { documentId: 42, userId: 7, teamId: 9 },
      {
        guardDocument: vi.fn().mockResolvedValue({
          id: 'envelope_42',
          secondaryId: 'document_42',
          teamId: 9,
        }),
        findEnvelope: vi.fn().mockRejectedValue(new Error('database unavailable')),
      },
    );

    expect(result).toEqual({
      status: 500,
      body: { message: 'Error retrieving the document. Please try again.' },
    });
  });
});
