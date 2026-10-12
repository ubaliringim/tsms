import type { NextConfig } from 'next';

/**
 * Stage 2.8 response headers for every page. The pages hold no authenticated data (identity is fetched
 * after load through the same-origin proxy), so these protect behaviour, not content: a page that can
 * sign a user in or out must not be framed by another origin, and nothing here is cacheable identity.
 *
 * The Content-Security-Policy below is deliberately PARTIAL. It states the directives that hold without
 * touching script execution - no plugins, no `<base>` hijack, no framing, same-origin form posts and
 * same-origin requests only. It sets NO `default-src`, `script-src` or `style-src`, because a safe
 * `script-src` for this application needs either per-request nonces (every page dynamically rendered) or
 * post-build hashing of Next's inline bootstrap scripts, both material architectural choices that are
 * recorded for the owner in docs/security/WEB_AUTHENTICATION.md. Nothing here pretends to be an XSS policy.
 */
const contentSecurityPolicy = [
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "connect-src 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default config;
