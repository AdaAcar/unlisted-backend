import { createHmac } from 'node:crypto';

import { env } from './env';

/**
 * Hashes personal request metadata before it can reach `db/` (agent-rules
 * section 3: no personal data in logs). Keyed HMAC-SHA-256, not a plain
 * digest: an unkeyed SHA-256 of an IPv4 address is reversible by brute force
 * in seconds (the whole space is 2^32), which would leave `ip_hash` as
 * personal data in another form. `env.auditHashSecret` throws when unset or
 * too short, so a misconfigured deployment fails audit writes closed rather
 * than silently hashing with a guessable or absent key.
 */
function keyedHash(value: string): string {
  return createHmac('sha256', env.auditHashSecret).update(value).digest('hex');
}

export function hashIpAddress(ip: string): string {
  return keyedHash(ip);
}

export function hashUserAgent(userAgent: string): string {
  return keyedHash(userAgent);
}
