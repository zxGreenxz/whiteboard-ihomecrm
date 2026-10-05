/** Only internal absolute paths can become a post-login destination. */
export function safeAuthRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  // Refuse URL-parser tricks and encoded separators/controls, including nested
  // percent encodings, while preserving ordinary query values such as 10%25.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;
  }
  if (/%(?:25)*(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  try {
    const url = new URL(value, 'https://internal.invalid');
    if (url.origin !== 'https://internal.invalid') return null;
    const pathname = decodeURIComponent(url.pathname);
    if (/^\/(?:login|register|forgot-password|reset-password)(?:\/|$)/i.test(pathname)) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    // URL/percent decoding can reject malformed user input: deliberately deny
    // this redirect, rather than treating a failed data request as empty data.
    return null;
  }
}

/** URL survives reload; legacy router state is only used without a next key. */
export function resolveLoginRedirect(search: string, state?: unknown): string {
  const query = new URLSearchParams(search);
  if (query.has('next')) return safeAuthRedirect(query.get('next')) ?? '/';
  if (!state || typeof state !== 'object' || !('from' in state)) return '/';
  const from = state.from;
  if (!from || typeof from !== 'object' || !('pathname' in from) || typeof from.pathname !== 'string') return '/';
  const searchPart = 'search' in from ? from.search : '';
  const hashPart = 'hash' in from ? from.hash : '';
  if (typeof searchPart !== 'string' || (searchPart !== '' && !searchPart.startsWith('?'))) return '/';
  if (typeof hashPart !== 'string' || (hashPart !== '' && !hashPart.startsWith('#'))) return '/';
  return safeAuthRedirect(from.pathname + searchPart + hashPart) ?? '/';
}
