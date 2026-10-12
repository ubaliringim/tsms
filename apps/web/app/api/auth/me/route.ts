import { relayAuthRequest } from '../../../../src/server/auth-proxy';

// Per-request and never cached: the response depends on the caller's cookie.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return relayAuthRequest('me', request, { environment: process.env });
}
