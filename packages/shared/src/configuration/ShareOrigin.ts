/**
 * SHARE_ORIGIN as an origin (scheme and host, no path or trailing slash), or
 * undefined when it is unset or not an http(s) URL. One rule for the server
 * that renders the page and the dev server that injects it.
 *
 * Its own file, free of enums, because vite.config.ts imports it and Vite
 * loads its config with Node's type stripping, which rejects enums.
 */
export function normalizeShareOrigin(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
