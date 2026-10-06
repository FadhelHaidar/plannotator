/**
 * The cheap cross-origin guard the servers' state-changing endpoints share
 * (config writes, review progress, guide share links, the CallDiff install).
 *
 * A browser attaches `Origin` to every cross-origin POST, including the
 * "simple" `text/plain` ones that skip a CORS preflight, so a page on another
 * site could otherwise write the user's config through a request the server
 * never sees as foreign. When the header is present it must name the host
 * the request was sent to; same-origin requests pass, and so do non-browser
 * clients (no Origin header), which already have the user's own access.
 *
 * Pure and dependency-free; vendored to Pi (generated/request-origin.ts).
 */
export function isSameOriginOrNoOrigin(originHeader: string | null | undefined, requestHost: string): boolean {
  if (!originHeader) return true;
  try {
    return new URL(originHeader).host === requestHost;
  } catch {
    return false;
  }
}
