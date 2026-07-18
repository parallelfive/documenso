import { afterAll, describe, expect, it, vi } from 'vitest';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { assertNotPrivateUrl, resolveVettedWebhookTarget } from './assert-webhook-url';

const fakeLookup = (addresses: Array<{ address: string; family: number }>) => {
  return vi.fn().mockResolvedValue(addresses);
};

const fakeLookupSingle = (address: string, family: number) => {
  return vi.fn().mockResolvedValue({ address, family });
};

describe('assertNotPrivateUrl', () => {
  describe('static URL checks', () => {
    it('should throw for localhost URLs', async () => {
      await expect(assertNotPrivateUrl('http://localhost:3000')).rejects.toThrow(AppError);
    });

    it('should throw for 127.0.0.1', async () => {
      await expect(assertNotPrivateUrl('http://127.0.0.1')).rejects.toThrow(AppError);
    });

    it('should throw for private IPs before DNS lookup', async () => {
      await expect(assertNotPrivateUrl('http://10.0.0.1')).rejects.toThrow(AppError);
      await expect(assertNotPrivateUrl('http://192.168.1.1')).rejects.toThrow(AppError);
    });

    it('should throw with WEBHOOK_INVALID_REQUEST error code', async () => {
      try {
        await assertNotPrivateUrl('http://localhost');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        if (!(err instanceof AppError)) {
          throw err;
        }

        expect(err.code).toBe(AppErrorCode.WEBHOOK_INVALID_REQUEST);
      }
    });
  });

  describe('DNS resolution checks', () => {
    it('should throw when hostname resolves to a private IPv4 address', async () => {
      const lookup = fakeLookup([{ address: '127.0.0.1', family: 4 }]);

      await expect(assertNotPrivateUrl('https://evil.example.com', { lookup })).rejects.toThrow(
        AppError,
      );
    });

    it('should throw when hostname resolves to a private IPv6 address', async () => {
      const lookup = fakeLookup([{ address: '::1', family: 6 }]);

      await expect(assertNotPrivateUrl('https://evil.example.com', { lookup })).rejects.toThrow(
        AppError,
      );
    });

    it('should throw when any resolved address is private', async () => {
      const lookup = fakeLookup([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);

      await expect(assertNotPrivateUrl('https://evil.example.com', { lookup })).rejects.toThrow(
        AppError,
      );
    });

    it('should allow hostnames that resolve to public addresses', async () => {
      const lookup = fakeLookup([{ address: '93.184.216.34', family: 4 }]);

      await expect(assertNotPrivateUrl('https://example.com', { lookup })).resolves.toBeUndefined();
    });

    it('should handle a single address result (non-array)', async () => {
      const lookup = fakeLookupSingle('10.0.0.1', 4);

      await expect(assertNotPrivateUrl('https://evil.example.com', { lookup })).rejects.toThrow(
        AppError,
      );
    });

    it('should handle a single public address result', async () => {
      const lookup = fakeLookupSingle('93.184.216.34', 4);

      await expect(assertNotPrivateUrl('https://example.com', { lookup })).resolves.toBeUndefined();
    });
  });

  describe('IP address URLs skip DNS', () => {
    it('should not perform DNS lookup for IP address URLs', async () => {
      const lookup = vi.fn();

      await assertNotPrivateUrl('https://8.8.8.8', { lookup });
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('transport confidentiality', () => {
    it('rejects cleartext HTTP even when the hostname resolves publicly', async () => {
      const lookup = fakeLookup([{ address: '93.184.216.34', family: 4 }]);

      await expect(
        resolveVettedWebhookTarget('http://public.example.com/callback', { lookup }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('DNS failure handling', () => {
    it('fails closed when DNS lookup throws', async () => {
      const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

      await expect(
        assertNotPrivateUrl('https://nonexistent.example.com', { lookup }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
    });

    it('should re-throw AppError even within the catch block', async () => {
      const lookup = fakeLookup([{ address: '192.168.0.1', family: 4 }]);

      await expect(assertNotPrivateUrl('https://evil.example.com', { lookup })).rejects.toThrow(
        AppError,
      );
    });

    it('fails closed when DNS lookup times out', async () => {
      vi.useFakeTimers();
      const lookup = vi.fn().mockReturnValue(new Promise(() => {}));

      const assertion = expect(
        assertNotPrivateUrl('https://slow.example.com', { lookup }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      vi.useRealTimers();
    }, 10_000);

    it('fails closed on empty or malformed DNS answers', async () => {
      await expect(
        assertNotPrivateUrl('https://empty.example.com', {
          lookup: fakeLookup([]),
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });

      await expect(
        assertNotPrivateUrl('https://malformed.example.com', {
          lookup: fakeLookup([{ address: 'not-an-ip', family: 4 }]),
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
    });

    it.each([
      { address: '169.254.169.254', family: 4 },
      { address: '::ffff:169.254.169.254', family: 6 },
      { address: 'fe80::1', family: 6 },
      { address: 'fc00::1', family: 6 },
      { address: '224.0.0.1', family: 4 },
      { address: '192.0.2.1', family: 4 },
      { address: '198.18.0.1', family: 4 },
      { address: '64:ff9b:1::1', family: 6 },
      { address: '100::1', family: 6 },
      { address: '100:0:0:1::1', family: 6 },
      { address: '2001:2::1', family: 6 },
      { address: '2001:20::1', family: 6 },
      { address: '2001:30::1', family: 6 },
      { address: '2620:4f:8000::1', family: 6 },
      { address: '3fff::1', family: 6 },
      { address: '5f00::1', family: 6 },
      { address: '4000::1', family: 6 },
    ])('rejects non-global DNS answer $address', async ({ address, family }) => {
      await expect(
        assertNotPrivateUrl('https://metadata.example.com', {
          lookup: fakeLookup([{ address, family }]),
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
    });

    it.each([
      { address: '198.17.255.255', family: 4 },
      { address: '198.20.0.1', family: 4 },
      { address: '2001:db7::1', family: 6 },
      { address: '2001:db9::1', family: 6 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])(
      'allows public address at a special-range boundary: $address',
      async ({ address, family }) => {
        await expect(
          assertNotPrivateUrl('https://public.example.com', {
            lookup: fakeLookup([{ address, family }]),
          }),
        ).resolves.toBeUndefined();
      },
    );
  });

  describe('explicit SSRF bypass', () => {
    const bypassHosts = new Set(['internal-webhook.example.com']);

    it('allows and returns a pinned private address only for the exact normalized host', async () => {
      const target = await resolveVettedWebhookTarget(
        'https://internal-webhook.example.com./callback',
        {
          bypassHosts,
          lookup: fakeLookup([{ address: '10.20.30.40', family: 4 }]),
        },
      );

      expect(target).toMatchObject({
        normalizedHostname: 'internal-webhook.example.com',
        address: { address: '10.20.30.40', family: 4 },
      });
    });

    it('allows cleartext HTTP only for an exact explicit bypass hostname', async () => {
      const target = await resolveVettedWebhookTarget(
        'http://internal-webhook.example.com/callback',
        {
          bypassHosts,
          lookup: fakeLookup([{ address: '10.20.30.40', family: 4 }]),
        },
      );

      expect(target).toMatchObject({
        url: new URL('http://internal-webhook.example.com/callback'),
        normalizedHostname: 'internal-webhook.example.com',
        address: { address: '10.20.30.40', family: 4 },
      });
    });

    it('does not apply bypass entries as suffixes or wildcards', async () => {
      await expect(
        resolveVettedWebhookTarget('http://evil.internal-webhook.example.com/callback', {
          bypassHosts,
          lookup: fakeLookup([{ address: '10.20.30.40', family: 4 }]),
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
    });

    it('still fails closed when exact-bypass DNS resolution fails', async () => {
      await expect(
        resolveVettedWebhookTarget('https://internal-webhook.example.com/callback', {
          bypassHosts,
          lookup: vi.fn().mockRejectedValue(new Error('SERVFAIL')),
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
    });
  });

  describe('configured development SSRF bypass', () => {
    const originalBypassHosts = process.env.NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS;

    it('allows the exact configured local callback through the same runtime policy', async () => {
      process.env.NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS = 'host.docker.internal';

      const target = await resolveVettedWebhookTarget(
        'http://host.docker.internal:3001/api/webhooks/documenso',
        {
          lookup: fakeLookup([{ address: '192.168.65.2', family: 4 }]),
        },
      );

      expect(target).toMatchObject({
        normalizedHostname: 'host.docker.internal',
        address: { address: '192.168.65.2', family: 4 },
      });
    });

    it('keeps ordinary HTTP and private targets denied when the bypass is unset', async () => {
      delete process.env.NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS;
      const publicLookup = fakeLookup([{ address: '93.184.216.34', family: 4 }]);
      const privateLookup = fakeLookup([{ address: '192.168.65.2', family: 4 }]);

      await expect(
        resolveVettedWebhookTarget('http://public.example.com/callback', {
          lookup: publicLookup,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });

      await expect(
        resolveVettedWebhookTarget('https://host.docker.internal/callback', {
          lookup: privateLookup,
        }),
      ).rejects.toMatchObject({
        code: AppErrorCode.WEBHOOK_INVALID_REQUEST,
      });
    });

    afterAll(() => {
      if (originalBypassHosts === undefined) {
        delete process.env.NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS;
      } else {
        process.env.NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS = originalBypassHosts;
      }
    });
  });
});
