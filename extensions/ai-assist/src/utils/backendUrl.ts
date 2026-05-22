/**
 * Build a request URL from the configured backend base.
 * Supports absolute URLs (http://localhost:8000) and same-origin path prefixes (/ai-api).
 */
export function buildBackendUrl(backendUrl: string, path: string): string {
  const base = backendUrl.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Parse a URL that may be relative when the backend is configured as a path prefix.
 */
export function parseResolvableUrl(url: string): URL {
  if (/^https?:\/\//i.test(url)) {
    return new URL(url);
  }
  return new URL(url, window.location.origin);
}
