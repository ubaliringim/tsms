import { relayAuthRequest } from '../../../../src/server/auth-proxy';

// Per-request and never cached: the response depends on the caller's cookie.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return relayAuthRequest('login', request, { environment: process.env });
}
