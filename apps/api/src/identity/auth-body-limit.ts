import { HttpStatus } from '@nestjs/common';

/**
 * Longest accepted login request body, in bytes.
 *
 * Small on purpose: the only JSON body in this stage is a login request, so a small limit rejects
 * an oversized payload before it is parsed or allocated.
 */
export const JSON_BODY_LIMIT_BYTES = 4 * 1024;

/** Same limit expressed for the adapter's parser, which expects a size string. */
export const JSON_BODY_LIMIT = `${JSON_BODY_LIMIT_BYTES}b`;

/** Minimal structural view of the platform request and response. */
interface PlatformRequest {
  readonly originalUrl?: string;
  readonly url?: string;
  readonly method?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}
interface PlatformResponse {
  readonly statusCode: number;
  status(code: number): PlatformResponse;
  json(body: unknown): unknown;
  end(): unknown;
}

/**
 * Reject an oversized login body on `Content-Length`, before the parser runs.
 *
 * The adapter also enforces the limit, and that is the real defence: it catches a chunked body
 * that understates its size. But relying on the parser alone means the status comes from an error
 * this layer does not control - Nest re-wraps a body-parser failure as its own `BadRequestException`,
 * so a too-large request and a malformed request become indistinguishable once they arrive. An
 * explicit early check keeps the documented `413` deterministic and testable.
 *
 * A request with no `Content-Length` is not rejected here; the adapter limit still applies.
 */
export function authJsonLimitGuard(
  request: PlatformRequest,
  response: PlatformResponse,
  next: () => void,
): void {
  if (response.statusCode === HttpStatus.PAYLOAD_TOO_LARGE) {
    // Already handled upstream; do not double-write.
    response.end();
    return;
  }
  const declared = request.headers['content-length'];
  if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
    next();
    return;
  }
  if (Number(declared) > JSON_BODY_LIMIT_BYTES) {
    response
      .status(HttpStatus.PAYLOAD_TOO_LARGE)
      .json({ statusCode: HttpStatus.PAYLOAD_TOO_LARGE, error: 'request_too_large' });
    return;
  }
  next();
}
