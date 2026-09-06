import { hashIpAddress, hashUserAgent } from '@/lib/hash';

interface HeaderSource {
  headers: { get(name: string): string | null };
}

/**
 * The hashed IP / user-agent pair every audited route hands to
 * `recordAuditEntry`. `x-forwarded-for` may list several hops; the first is
 * the client. No raw IP or user agent is returned — only `lib/hash.ts`'s
 * keyed HMAC digests (agent-rules section 3).
 */
export function auditMeta(request: HeaderSource): { ipHash: string; userAgentHash: string } {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return {
    ipHash: hashIpAddress(ip),
    userAgentHash: hashUserAgent(request.headers.get('user-agent') ?? 'unknown'),
  };
}
