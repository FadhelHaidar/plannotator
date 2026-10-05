/**
 * Bun adapter for the host-only session control endpoints
 * (`/api/host/status`, `/api/host/close`; packages/shared/host-control.ts).
 * The Pi mirror lives in apps/pi-extension/server/host-control.ts.
 */

import {
  handleHostControlRequest,
  type HostControl,
} from "@plannotator/shared/host-control";
import { takeEnvPullSessionBridgeConfig } from "./ai-runtime";
import { isRemoteSession } from "./remote";

export type { HostControl, HostSessionStatus, HostCloseOutcome } from "@plannotator/shared/host-control";

/**
 * The token the host-control endpoints accept: `explicit` (tests, an
 * in-process caller), else the pull-bridge token the host launched this CLI
 * with. Available exactly where the pull bridge is: never in remote mode, and
 * `--tailscale` discards the env token before any server starts.
 */
export function resolveHostControlToken(explicit?: string): string | undefined {
  if (isRemoteSession()) return undefined;
  return explicit ?? takeEnvPullSessionBridgeConfig()?.token;
}

/** The response for a host-control path, or null when the request is not one. */
export function handleHostControl(
  req: Request,
  url: URL,
  route: { token: string | undefined; getServerPort: () => number | undefined; control: HostControl },
): Response | null {
  const answer = handleHostControlRequest(
    {
      method: req.method,
      pathname: url.pathname,
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      authorization: req.headers.get("authorization"),
    },
    route,
  );
  return answer ? Response.json(answer.body, { status: answer.status }) : null;
}
