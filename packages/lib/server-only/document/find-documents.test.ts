import { describe, expect, it, vi } from 'vitest';

import {
  type EnvelopeQueryBuilder,
  applyDeterministicDocumentOrder,
  applyExactTeamOnlyDocumentFilter,
  resolveUseWindowedDocumentCount,
} from './find-documents';

const queryBuilder = () => {
  const query = {
    where: vi.fn(),
  };
  query.where.mockReturnValue(query);

  return query;
};

describe('applyExactTeamOnlyDocumentFilter', () => {
  it('adds the API token team predicate before cross-team team-email branches can leak metadata', () => {
    const query = queryBuilder();

    const result = applyExactTeamOnlyDocumentFilter(
      query as unknown as EnvelopeQueryBuilder,
      true,
      9,
    );

    expect(result).toBe(query);
    expect(query.where).toHaveBeenCalledWith('Envelope.teamId', '=', 9);
  });

  it('preserves native UI list semantics unless exact-team mode is requested', () => {
    const query = queryBuilder();

    const result = applyExactTeamOnlyDocumentFilter(
      query as unknown as EnvelopeQueryBuilder,
      false,
      9,
    );

    expect(result).toBe(query);
    expect(query.where).not.toHaveBeenCalled();
  });

  it('fails closed if exact-team mode is requested without a team', () => {
    const query = queryBuilder();

    expect(() =>
      applyExactTeamOnlyDocumentFilter(query as unknown as EnvelopeQueryBuilder, true, undefined),
    ).toThrow('Exact-team document queries require a team ID');
  });
});

describe('applyDeterministicDocumentOrder', () => {
  it('adds an envelope-id tie breaker so equal timestamps page stably', () => {
    const query = {
      orderBy: vi.fn(),
    };
    query.orderBy.mockReturnValue(query);

    const result = applyDeterministicDocumentOrder(
      query as unknown as EnvelopeQueryBuilder,
      'createdAt',
      'desc',
    );

    expect(result).toBe(query);
    expect(query.orderBy.mock.calls).toEqual([
      ['Envelope.createdAt', 'desc'],
      ['Envelope.id', 'desc'],
    ]);
  });
});

describe('resolveUseWindowedDocumentCount', () => {
  it('defaults exact-team external lists to a full count beyond the UI window', () => {
    expect(resolveUseWindowedDocumentCount(true, undefined)).toBe(false);
  });

  it('preserves the fast windowed default for native UI lists', () => {
    expect(resolveUseWindowedDocumentCount(false, undefined)).toBe(true);
  });

  it.each([
    { exactTeamOnly: true, requested: true },
    { exactTeamOnly: false, requested: true },
    { exactTeamOnly: true, requested: false },
    { exactTeamOnly: false, requested: false },
  ])('honors explicit $requested for exactTeamOnly=$exactTeamOnly', (input) => {
    expect(resolveUseWindowedDocumentCount(input.exactTeamOnly, input.requested)).toBe(
      input.requested,
    );
  });
});
