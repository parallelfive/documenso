import { describe, expect, it } from 'vitest';

import { AppErrorCode } from '../../errors/app-error';
import { assertBizBuddyExternalIdAuthorized } from './assert-bizbuddy-external-id-authorized';

describe('assertBizBuddyExternalIdAuthorized', () => {
  it.each(['bizbuddy:reserved', 'BIZBUDDY:reserved'])(
    'rejects unauthorized namespace minting: %s',
    (externalId) => {
      expect(() => assertBizBuddyExternalIdAuthorized({ externalId })).toThrow(
        expect.objectContaining({ code: AppErrorCode.CONFLICT }),
      );
    },
  );

  it('allows the dedicated creation path to mint a canonical correlated ID', () => {
    expect(() =>
      assertBizBuddyExternalIdAuthorized({
        externalId: 'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
        allowReservedNamespace: true,
      }),
    ).not.toThrow();
  });

  it.each([
    'bizbuddy:not-a-uuid',
    'BIZBUDDY:123e4567-e89b-42d3-a456-426614174000',
    'bizbuddy:123E4567-E89B-42D3-A456-426614174000',
  ])('rejects a non-canonical ID on the dedicated creation path: %s', (externalId) => {
    expect(() =>
      assertBizBuddyExternalIdAuthorized({
        externalId,
        allowReservedNamespace: true,
      }),
    ).toThrow(expect.objectContaining({ code: AppErrorCode.INVALID_BODY }));
  });

  it('leaves unrelated customer external IDs available', () => {
    expect(() =>
      assertBizBuddyExternalIdAuthorized({ externalId: 'customer-document-123' }),
    ).not.toThrow();
  });
});
