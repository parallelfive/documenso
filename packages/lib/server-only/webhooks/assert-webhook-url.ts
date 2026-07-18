import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { withTimeout } from '../../utils/timeout';
import { isPrivateUrl } from './is-private-url';

const WEBHOOK_DNS_LOOKUP_TIMEOUT_MS = 2_000;

// Conservative denylist derived from the IANA IPv4/IPv6 special-purpose
// registries, last updated 2025-10-09:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Webhooks do not need special-purpose anycast/translation ranges, even when
// IANA marks one globally reachable. ipaddr.js 1.x labels several of these as
// "unicast", so range() alone is not a global-routability policy.
const NON_GLOBAL_IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));

const NON_GLOBAL_IPV6_RANGES = [
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '100:0:0:1::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '2620:4f:8000::/48',
  '3fff::/20',
  '5f00::/16',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));
const GLOBAL_UNICAST_IPV6_RANGE = ipaddr.IPv6.parseCIDR('2000::/3');

export type VettedWebhookAddress = {
  address: string;
  family: 4 | 6;
};

export type VettedWebhookTarget = {
  url: URL;
  normalizedHostname: string;
  address: VettedWebhookAddress;
};

type TLookupAddress = {
  address: string;
  family: number;
};

type TLookupFn = (
  hostname: string,
  options: {
    all: true;
    verbatim: true;
  },
) => Promise<TLookupAddress[] | TLookupAddress>;

const normalizeHostname = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.+$/, '');

const invalidWebhookUrl = (message: string) =>
  new AppError(AppErrorCode.WEBHOOK_INVALID_REQUEST, {
    message,
  });

/**
 * Parse the NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS environment variable into
 * a Set of exact, normalized hostnames/IPs. Bypasses may resolve to private
 * addresses, but DNS is still fail-closed and the request is still pinned to
 * the resolved address.
 */
const webhookSSRFBypassHosts = (): Set<string> => {
  const raw = process.env['NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS'] ?? '';
  const hosts = new Set<string>();

  for (const entry of raw.split(',')) {
    const trimmed = normalizeHostname(entry.trim());

    if (trimmed.length > 0) {
      hosts.add(trimmed);
    }
  }

  return hosts;
};

const parseVettedAddress = (
  address: string,
  family: number,
  allowPrivate: boolean,
): VettedWebhookAddress => {
  let parsedAddress: ipaddr.IPv4 | ipaddr.IPv6;

  try {
    parsedAddress = ipaddr.parse(address);
  } catch {
    throw invalidWebhookUrl('Webhook hostname returned an invalid DNS address');
  }

  const parsedFamily = parsedAddress.kind() === 'ipv4' ? 4 : 6;
  if ((family !== 4 && family !== 6) || family !== parsedFamily) {
    throw invalidWebhookUrl('Webhook hostname returned an invalid DNS address family');
  }

  let isExplicitlyNonGlobal: boolean;
  let isAllocatedGlobalUnicast: boolean;

  if (parsedAddress instanceof ipaddr.IPv4) {
    isExplicitlyNonGlobal = NON_GLOBAL_IPV4_RANGES.some((range) => parsedAddress.match(range));
    isAllocatedGlobalUnicast = true;
  } else {
    isExplicitlyNonGlobal = NON_GLOBAL_IPV6_RANGES.some((range) => parsedAddress.match(range));
    isAllocatedGlobalUnicast = parsedAddress.match(GLOBAL_UNICAST_IPV6_RANGE);
  }

  if (
    !allowPrivate &&
    (parsedAddress.range() !== 'unicast' || !isAllocatedGlobalUnicast || isExplicitlyNonGlobal)
  ) {
    throw invalidWebhookUrl('Webhook URL resolves to a non-global address');
  }

  return {
    address: parsedAddress.toNormalizedString(),
    family: parsedFamily,
  };
};

/**
 * Parses and resolves a webhook URL exactly once. Every returned DNS answer
 * must be a globally routable address unless the hostname is an explicit
 * bypass. Resolution error, timeout, empty answers, malformed answers, or any
 * mixed private/special-use answer fail closed.
 */
export const resolveVettedWebhookTarget = async (
  url: string,
  options?: {
    lookup?: TLookupFn;
    bypassHosts?: ReadonlySet<string>;
  },
): Promise<VettedWebhookTarget> => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw invalidWebhookUrl('Webhook URL is invalid');
  }

  const normalizedHostname = normalizeHostname(parsedUrl.hostname);
  if (normalizedHostname.length === 0) {
    throw invalidWebhookUrl('Webhook URL hostname is invalid');
  }

  const bypassHosts = options?.bypassHosts ?? webhookSSRFBypassHosts();
  const isBypassed = bypassHosts.has(normalizedHostname);

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw invalidWebhookUrl('Webhook URL must use HTTP or HTTPS');
  }

  if (parsedUrl.protocol !== 'https:' && !isBypassed) {
    throw invalidWebhookUrl('Webhook URL must use HTTPS');
  }

  if (!isBypassed && isPrivateUrl(parsedUrl.toString())) {
    throw invalidWebhookUrl('Webhook URL resolves to a non-global address');
  }

  const literalFamily = isIP(normalizedHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return {
      url: parsedUrl,
      normalizedHostname,
      address: parseVettedAddress(normalizedHostname, literalFamily, isBypassed),
    };
  }

  const resolveHostname = options?.lookup ?? lookup;
  let lookupResult: TLookupAddress[] | TLookupAddress | null;

  try {
    lookupResult = await withTimeout(
      resolveHostname(normalizedHostname, {
        all: true,
        verbatim: true,
      }),
      WEBHOOK_DNS_LOOKUP_TIMEOUT_MS,
    );
  } catch {
    throw invalidWebhookUrl('Webhook hostname could not be resolved');
  }

  if (!lookupResult) {
    throw invalidWebhookUrl('Webhook hostname resolution timed out');
  }

  const addresses = Array.isArray(lookupResult) ? lookupResult : [lookupResult];
  if (addresses.length === 0) {
    throw invalidWebhookUrl('Webhook hostname returned no addresses');
  }

  const vettedAddresses = addresses.map(({ address, family }) =>
    parseVettedAddress(address, family, isBypassed),
  );

  return {
    url: parsedUrl,
    normalizedHostname,
    address: vettedAddresses[0],
  };
};

/**
 * Compatibility assertion for webhook registration paths. Delivery uses
 * resolveVettedWebhookTarget directly so it can bind the socket to the vetted
 * address and avoid a second ambient DNS lookup.
 */
export const assertNotPrivateUrl = async (
  url: string,
  options?: {
    lookup?: TLookupFn;
    bypassHosts?: ReadonlySet<string>;
  },
) => {
  await resolveVettedWebhookTarget(url, options);
};
