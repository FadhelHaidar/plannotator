/**
 * The Pi side of the `plannotator` agent tool (contract:
 * packages/shared/plannotator-tool.ts, vendored as generated/plannotator-tool.ts).
 *
 * The extension keeps one registry per extension instance (one Pi session):
 * every review it opens, through the tool, a /plannotator-* command, or
 * plannotator_submit_plan, is recorded here with a `pn-` session id until its
 * decision settles. `list` and `close` read only this registry, filtered to
 * the Pi session that opened each review, so another Pi session's reviews
 * (or another project's) are never in reach.
 *
 * Closing calls the server's in-process host control (`HostControl.close`,
 * packages/shared/host-control.ts): the reviewer's Close, marked
 * `closedBy: "agent"`, with the draft kept. Plan reviews are listed but end
 * only with the reviewer's decision (or by leaving plan mode).
 *
 * Pure apart from the clock and the id source, both injectable for tests.
 */

import { randomBytes } from "node:crypto";
import type { HostControl } from "./generated/host-control.ts";
import {
	plannotatorSessionId,
	plannotatorToolCloseText,
	plannotatorToolListText,
	plannotatorUnknownSessionText,
	type PlannotatorCloseOutcome,
	type PlannotatorSessionSummary,
} from "./generated/plannotator-tool.ts";

export type PiReviewKind = PlannotatorSessionSummary["kind"];

export interface PiOpenReview {
	/** `pn-` + 6 hex, unique among this registry's open reviews. */
	id: string;
	kind: PiReviewKind;
	subject: string;
	url: string;
	startedAt: number;
	/** The Pi session id that opened it (`ctx.sessionManager.getSessionId()`). */
	owner: string | undefined;
	/** The server's in-process host control; absent for a server without it. */
	hostControl?: HostControl;
	/** The agent closed it: hidden from list/close while the server shuts down; nothing is delivered. */
	closedByAgent: boolean;
}

export interface PiReviewRegistry {
	/** Record a review that just opened and give it a session id. */
	add(entry: Pick<PiOpenReview, "kind" | "subject" | "url" | "owner" | "hostControl">): PiOpenReview;
	/** Forget a review once its decision settled or its server stopped. */
	remove(review: PiOpenReview): void;
	/** The open reviews `owner` opened (not closed by the agent), oldest first. */
	openFor(owner: string | undefined): PiOpenReview[];
	/** The tool's `list` result for `owner`. */
	listText(owner: string | undefined): string;
	/** The tool's `close` for `owner`: one session id or "all". `ok: false` is an error result. */
	close(owner: string | undefined, session: string): { ok: boolean; text: string };
}

export function createPiReviewRegistry(
	options: { now?: () => number; randomHex?: () => string } = {},
): PiReviewRegistry {
	const now = options.now ?? Date.now;
	const randomHex = options.randomHex ?? (() => randomBytes(3).toString("hex"));
	const reviews = new Map<string, PiOpenReview>();

	const newId = (): string => {
		let value = Number.parseInt(randomHex(), 16) || 0;
		let id = plannotatorSessionId(value.toString(16).padStart(6, "0"));
		while (reviews.has(id)) {
			value = (value + 1) % 0x1000000;
			id = plannotatorSessionId(value.toString(16).padStart(6, "0"));
		}
		return id;
	};

	const openFor = (owner: string | undefined): PiOpenReview[] =>
		[...reviews.values()].filter((review) => !review.closedByAgent && review.owner === owner);

	const statusOf = (review: PiOpenReview) => {
		try {
			return review.hostControl?.status() ?? null;
		} catch {
			return null;
		}
	};

	const closeOne = (review: PiOpenReview): PlannotatorCloseOutcome => {
		const { id, subject } = review;
		if (review.kind === "plan") return { id, subject, closed: false, reason: "plan" };
		const close = review.hostControl?.close;
		if (!close) {
			return { id, subject, closed: false, reason: "failed", detail: "this review cannot be closed from here; close it from the tab" };
		}
		try {
			const outcome = close();
			if (outcome.closed) {
				review.closedByAgent = true;
				return { id, subject, closed: true, unsent: outcome.unsentAnnotations };
			}
			return outcome.reason === "decided"
				? { id, subject, closed: false, reason: "decided" }
				: { id, subject, closed: false, reason: "failed", detail: "it ends only with the reviewer's decision" };
		} catch (err) {
			return { id, subject, closed: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		add(entry) {
			const review: PiOpenReview = { ...entry, id: newId(), startedAt: now(), closedByAgent: false };
			reviews.set(review.id, review);
			return review;
		},
		remove(review) {
			if (reviews.get(review.id) === review) reviews.delete(review.id);
		},
		openFor,
		listText(owner) {
			const at = now();
			const sessions: PlannotatorSessionSummary[] = openFor(owner).map((review) => {
				const status = statusOf(review);
				return {
					id: review.id,
					kind: review.kind,
					subject: review.subject,
					url: review.url,
					ageMs: at - review.startedAt,
					state: status?.decided ? "decided" : "open",
					unsent: status ? status.unsentAnnotations : null,
				};
			});
			return plannotatorToolListText(sessions);
		},
		close(owner, session) {
			if (session === "all") {
				return { ok: true, text: plannotatorToolCloseText(openFor(owner).map(closeOne)) };
			}
			const review = openFor(owner).find((candidate) => candidate.id === session);
			if (!review) return { ok: false, text: plannotatorUnknownSessionText(session) };
			const outcome = closeOne(review);
			return { ok: outcome.closed, text: plannotatorToolCloseText([outcome]) };
		},
	};
}

function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return trimmed.slice(slash + 1) || trimmed;
}

const PR_URL = /^https?:\/\/[^\s/]+\/.+\/(?:pull|pull-requests|merge_requests)\/(\d+)\b/i;

/** How a review names an annotate target: a URL by its host, a file or folder by its last segment. */
export function annotateSubject(target: string): string {
	if (/^https?:\/\//i.test(target)) {
		try {
			return new URL(target).host;
		} catch {
			return target;
		}
	}
	return baseName(target) || "document";
}

/** How a review names code review: `PR #12` / `MR !12`, the reviewed directory, or local changes. */
export function reviewSubject(prUrl: string | undefined, directory: string | undefined): string {
	if (prUrl) {
		const match = PR_URL.exec(prUrl);
		if (match) return /merge_requests/i.test(prUrl) ? `MR !${match[1]}` : `PR #${match[1]}`;
		return prUrl;
	}
	return directory ? `changes in ${baseName(directory)}` : "local changes";
}

/** How a review names the last-message surface (several messages when the picker is offered). */
export function lastMessageSubject(messageCount: number): string {
	return messageCount > 1 ? "your recent messages" : "your last message";
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** ` · 3 comments` for a decision that carried comments; empty otherwise. */
export function commentCountSuffix(annotations: unknown): string {
	const count = Array.isArray(annotations) ? annotations.length : 0;
	return count > 0 ? ` · ${plural(count, "comment", "comments")}` : "";
}

/** The notification after the agent closed a review: nothing is delivered for it. */
export function agentClosedNotice(review: Pick<PiOpenReview, "id" | "subject">, unsent: number | undefined): string {
	const saved = typeof unsent === "number" && unsent > 0
		? ` ${plural(unsent, "unsent comment", "unsent comments")} kept in the draft.`
		: "";
	return `Plannotator: the agent closed ${review.subject} (${review.id}).${saved} Nothing was sent to the agent.`;
}
