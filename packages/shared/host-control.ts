/**
 * Host-only session control: `GET /api/host/status` and `POST /api/host/close`.
 *
 * The agent session that launched a review (the Claude Code mod today; Pi and
 * OpenCode 2 through the same functions in-process) can ask what the review
 * holds and close it when it no longer needs it. Closing is the reviewer's
 * Close (decision `dismissed`, nothing sent to the agent) except that it is
 * marked `closedBy: "agent"` and the annotation draft is KEPT (it is not
 * deleted; whether a later session restores it follows that surface's own
 * draft key: annotate by document content, code review by patch or PR).
 *
 * Guarded exactly like the pull bridge (packages/ai/session-bridge-pull.ts):
 * a loopback Host header naming this server's port (DNS-rebinding guard), no
 * `Origin` header (a browser page is never the host), and
 * `Authorization: Bearer <token>`, the per-launch secret the host started the
 * server with (`PLANNOTATOR_SESSION_BRIDGE_TOKEN`). Without a token the paths
 * answer 404 with `code: "host_control_disabled"`, which a host reads as
 * "turned off" (an uncoded 404 is "an older Plannotator"). Available wherever
 * the host launched the server with that token, including under
 * `PLANNOTATOR_AI=disabled` (which turns the pull bridge itself off); never in
 * remote mode or a `--tailscale` session (which discards the token).
 *
 * Privacy: status carries counts, never comment text.
 *
 * Runtime-agnostic (vendored to Pi): plain data in and out; each server turns
 * the answer into its own response type.
 */

import { isLoopbackHostHeader } from "./loopback-host";

export const HOST_STATUS_PATH = "/api/host/status";
export const HOST_CLOSE_PATH = "/api/host/close";
/** The `code` of the 404 the endpoints answer while turned off (remote mode, no token). */
export const HOST_CONTROL_DISABLED_CODE = "host_control_disabled";

export type HostSessionKind = "plan" | "annotate" | "annotate-last" | "review";

/** `GET /api/host/status`. */
export interface HostSessionStatus {
	kind: HostSessionKind;
	/** What the session shows: the file(s), folder or URL; empty for plan, message and code review. */
	documents: string[];
	/** Comments the reviewer wrote and has not sent (from the autosaved draft). */
	unsentAnnotations: number;
	/** The reviewer (or an earlier close) already decided; the server is shutting down. */
	decided: boolean;
}

/** What `close()` reports. */
export type HostCloseOutcome =
	| { closed: true; unsentAnnotations: number }
	| { closed: false; reason: "decided" | "not-closable" };

export interface HostControl {
	status(): HostSessionStatus;
	/** Absent: this kind of session cannot be closed by the host (plan review). */
	close?: () => HostCloseOutcome;
}

/**
 * The comments a draft holds that the REVIEWER wrote and has not sent:
 * document annotations, code annotations, and code review's PR description
 * and PR comment notes. Entries carrying a `source` (review agents, WebMCP
 * browser agents, linters and other external tools) are not the reviewer's
 * and are not counted.
 */
export function countUnsentDraftComments(draft: unknown): number {
	if (!draft || typeof draft !== "object") return 0;
	const value = draft as Record<string, unknown>;
	const count = (list: unknown) =>
		Array.isArray(list)
			? list.filter((entry) => {
					if (!entry || typeof entry !== "object") return false;
					const source = (entry as { source?: unknown }).source;
					return typeof source !== "string" || source.length === 0;
				}).length
			: 0;
	return (
		count(value.annotations) +
		count(value.codeAnnotations) +
		count(value.descriptionAnnotations) +
		count(value.commentAnnotations)
	);
}

/** Constant-time comparison of two short ASCII tokens. */
function tokensEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

export interface HostControlRequest {
	method: string;
	pathname: string;
	host: string | null;
	origin: string | null;
	authorization: string | null;
}

export interface HostControlAnswer {
	status: number;
	body: unknown;
}

export interface HostControlRoute {
	/** The launch's token; undefined turns the endpoints off (404). */
	token: string | undefined;
	getServerPort: () => number | undefined;
	control: HostControl;
}

/** True for the two host-control paths. */
export function isHostControlPath(pathname: string): boolean {
	return pathname === HOST_STATUS_PATH || pathname === HOST_CLOSE_PATH;
}

/**
 * Answer a host-control request, or null when the path is not one. Guards in
 * order: off (404), Host (403), Origin (403), token (401), then method (405).
 */
export function handleHostControlRequest(request: HostControlRequest, route: HostControlRoute): HostControlAnswer | null {
	if (!isHostControlPath(request.pathname)) return null;
	// Off (remote mode, or launched without a token): a 404 like an unknown
	// path, but with a code, so a host can tell "this Plannotator turned host
	// control off" from "this Plannotator predates it" and not fall back to
	// signalling its process.
	if (!route.token) return { status: 404, body: { error: "Not found", code: HOST_CONTROL_DISABLED_CODE } };
	if (!isLoopbackHostHeader(request.host, route.getServerPort())) {
		return { status: 403, body: { error: "Host control answers only this machine.", code: "host_control_forbidden_host" } };
	}
	if (request.origin) {
		return { status: 403, body: { error: "Browser requests are not accepted here.", code: "host_control_forbidden_origin" } };
	}
	const match = /^Bearer\s+(\S+)$/i.exec((request.authorization ?? "").trim());
	if (!match || !tokensEqual(match[1] as string, route.token)) {
		return { status: 401, body: { error: "Missing or wrong host token.", code: "host_control_unauthorized" } };
	}

	if (request.pathname === HOST_STATUS_PATH) {
		if (request.method !== "GET") return { status: 405, body: { error: "Use GET." } };
		return { status: 200, body: route.control.status() };
	}

	if (request.method !== "POST") return { status: 405, body: { error: "Use POST." } };
	const close = route.control.close;
	if (!close) {
		return { status: 409, body: { error: "This session ends only with the reviewer's decision.", code: "not_closable" } };
	}
	const outcome = close();
	if (!outcome.closed) {
		return outcome.reason === "decided"
			? { status: 409, body: { error: "This session has already been decided.", code: "already_decided" } }
			: { status: 409, body: { error: "This session ends only with the reviewer's decision.", code: "not_closable" } };
	}
	return { status: 200, body: { unsentAnnotations: outcome.unsentAnnotations } };
}

/** The external-annotation SSE event that tells open tabs the agent closed the review. */
export interface HostSessionClosedEvent {
	type: "session-closed";
	by: "agent";
	unsentAnnotations: number;
}

export function hostSessionClosedEvent(unsentAnnotations: number): HostSessionClosedEvent {
	return { type: "session-closed", by: "agent", unsentAnnotations };
}
