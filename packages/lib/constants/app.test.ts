import { describe, expect, it } from 'vitest';

import { buildRecipientSigningLink } from './app';

describe('buildRecipientSigningLink', () => {
  it.each([
    'https://bizbuddy.example',
    'https://bizbuddy.example/',
    'https://bizbuddy.example/sign',
    'https://bizbuddy.example/sign/',
  ])('builds the Biz Buddy callback without a duplicate sign segment for %s', (prefix) => {
    expect(
      buildRecipientSigningLink({
        externalId: 'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
        recipientToken: 'provider+token',
        signingUrlPrefix: prefix,
        webappUrl: 'https://documenso.example',
      }),
    ).toBe(
      'https://bizbuddy.example/sign/123e4567-e89b-42d3-a456-426614174000?p=provider%2Btoken',
    );
  });

  it('keeps the native Documenso link when the callback prefix is not configured', () => {
    expect(
      buildRecipientSigningLink({
        externalId: 'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
        recipientToken: 'provider-token',
        signingUrlPrefix: '',
        webappUrl: 'https://documenso.example/',
      }),
    ).toBe('https://documenso.example/sign/provider-token');
  });

  it('treats a whitespace-only callback prefix as unconfigured', () => {
    expect(
      buildRecipientSigningLink({
        externalId: 'bizbuddy:123e4567-e89b-42d3-a456-426614174000',
        recipientToken: 'provider-token',
        signingUrlPrefix: '   ',
        webappUrl: ' https://documenso.example/ ',
      }),
    ).toBe('https://documenso.example/sign/provider-token');
  });

  it('keeps the native Documenso link for documents without a Biz Buddy external ID', () => {
    expect(
      buildRecipientSigningLink({
        externalId: null,
        recipientToken: 'provider-token',
        signingUrlPrefix: 'https://bizbuddy.example/sign',
        webappUrl: 'https://documenso.example',
      }),
    ).toBe('https://documenso.example/sign/provider-token');
  });

  it.each([
    'customer-document-123',
    'bizbuddy:not-a-uuid',
    'bizbuddy:123e4567-e89b-42d3-a456-426614174000:extra',
  ])('keeps the native Documenso link for non-Biz-Buddy external ID %s', (externalId) => {
    expect(
      buildRecipientSigningLink({
        externalId,
        recipientToken: 'provider-token',
        signingUrlPrefix: 'https://bizbuddy.example/sign',
        webappUrl: 'https://documenso.example',
      }),
    ).toBe('https://documenso.example/sign/provider-token');
  });
});
