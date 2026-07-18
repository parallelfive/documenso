import { describe, expect, it } from 'vitest';

import { getNextSignerIdentityOverride } from './next-signer-identity';

const nextSigner = {
  name: 'Replacement Signer',
  email: 'replacement@example.test',
};

describe('getNextSignerIdentityOverride', () => {
  it.each([
    'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
    'BIZBUDDY:123e4567-e89b-42d3-a456-426614174000',
  ])(
    'does not mutate the next recipient identity for a preexisting correlated row: %s',
    (externalId) => {
      expect(
        getNextSignerIdentityOverride({
          externalId,
          allowDictateNextSigner: true,
          nextSigner,
        }),
      ).toBeNull();
    },
  );

  it('preserves native next-signer identity replacement', () => {
    expect(
      getNextSignerIdentityOverride({
        externalId: 'native-document',
        allowDictateNextSigner: true,
        nextSigner,
      }),
    ).toEqual(nextSigner);
  });
});
