/**
 * The `plannotator` agent tool on Pi (contract: packages/shared/plannotator-tool.ts).
 *
 * Driven through the real extension with a fake Pi host. Annotate sessions
 * run a REAL in-process annotate server (only the browser launch is skipped),
 * so close, unsent counts and decisions go through the server's own host
 * control.
 *
 * What regresses if this fails:
 *  - Pi's tool validator refuses the shared plain JSON Schema, so every call fails;
 *  - the tool forks the contract (name, schema, description) instead of using it;
 *  - opening blocks the turn, or opens without the Ask-this-session bridge;
 *  - the reviewer's decision never reaches the agent, or arrives without the
 *    `Plannotator: <subject> (pn-…) — <outcome>.` heading that names the session;
 *  - a gated session the agent opened swallows a bare approval it was told to wait for;
 *  - list/close reach another Pi session's reviews, close deletes the
 *    reviewer's draft or delivers a message, or a plan review can be closed;
 *  - a list of files, `reply`, or a session without UI opens anything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import plannotator, { type PlannotatorExtensionDeps } from "./index.ts";
import {
	PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
	PLANNOTATOR_TOOL_DESCRIPTION,
	PLANNOTATOR_TOOL_INPUT_SCHEMA,
	PLANNOTATOR_TOOL_NAME,
	PLANNOTATOR_TOOL_REPLY_UNAVAILABLE_TEXT,
} from "./generated/plannotator-tool.ts";
import type { PlanReviewDecision } from "./plannotator-browser.ts";
import { startAnnotateServer } from "./server/serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY", "PLANNOTATOR_ANNOTATE_HISTORY"] as const;

const tempDirs: string[] = [];
const servers: Array<{ stop: () => void }> = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-tool-data-"));
	tempDirs.push(dataDir);
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
	process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
	delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key]!;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ToolResult = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; terminate?: boolean };
type Tool = { name: string; description: string; parameters: unknown; executionMode?: string; execute: (...args: unknown[]) => Promise<ToolResult> };

interface AnnotateLaunch {
	filePath: string;
	gate: boolean | undefined;
	sessionBridge: unknown;
	url: string;
}

function createHarness(options: { sessionId?: string; hasUI?: boolean; deps?: PlannotatorExtensionDeps } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "plannotator-pi-tool-"));
	tempDirs.push(cwd);
	const tools = new Map<string, Tool>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sent: Array<{ text: string; options: unknown }> = [];
	const notices: Array<{ message: string; type: string }> = [];
	const annotateLaunches: AnnotateLaunch[] = [];
	const planReviews: Array<{ decide: (result: PlanReviewDecision) => void }> = [];

	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		getFlag: () => false,
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getCommands: () => [],
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: (text: string, sendOptions: unknown) => sent.push({ text, options: sendOptions }),
	};

	const makeCtx = (sessionId: string) => ({
		cwd,
		hasUI: options.hasUI ?? true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string, type = "info") => notices.push({ message, type }),
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	});
	const ctx = makeCtx(options.sessionId ?? "pi-session-a");

	// A real annotate server; only the browser launch is skipped.
	const startAnnotation: NonNullable<PlannotatorExtensionDeps["startAnnotation"]> = async (
		_ctx, filePath, markdown, mode, folderPath, _sourceInfo, _converted, gate, _rawHtml, _renderHtml, _convertHtml, _recent, _live, sessionBridge,
	) => {
		const server = await startAnnotateServer({ markdown, filePath, mode, folderPath, gate, htmlContent: MINIMAL_HTML });
		servers.push(server);
		annotateLaunches.push({ filePath, gate, sessionBridge, url: server.url });
		return { url: server.url, waitForDecision: server.waitForDecision, stop: server.stop, hostControl: server.hostControl };
	};

	const startPlanReview: NonNullable<PlannotatorExtensionDeps["startPlanReview"]> = async () => {
		let resolve!: (result: PlanReviewDecision) => void;
		const decision = new Promise<PlanReviewDecision>((res) => {
			resolve = res;
		});
		planReviews.push({ decide: resolve });
		return {
			url: `http://localhost:${5000 + planReviews.length}`,
			reviewId: `plan-${planReviews.length}`,
			waitForDecision: () => decision,
			onDecision: () => () => undefined,
			stop: () => undefined,
			updatePlan: () => null,
			hostControl: { status: () => ({ kind: "plan", documents: [], unsentAnnotations: 0, decided: false }) },
		} as never;
	};

	plannotator(pi as never, {
		hasPlanBrowserHtml: () => true,
		hasReviewBrowserHtml: () => true,
		startAnnotation,
		startPlanReview,
		...options.deps,
	});

	const tool = () => tools.get(PLANNOTATOR_TOOL_NAME)!;
	return {
		cwd,
		ctx,
		makeCtx,
		tools,
		sent,
		notices,
		annotateLaunches,
		planReviews,
		tool,
		call(params: unknown, callCtx: unknown = ctx) {
			return tool().execute("call-1", params, undefined, undefined, callCtx);
		},
		async command(name: string, args: string) {
			await commands.get(name)!.handler(args, ctx);
		},
		async startSession() {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		},
		writeFile(name: string, content: string) {
			const path = join(cwd, name);
			writeFileSync(path, content);
			return path;
		},
	};
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

const postJson = (url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const sessionIdIn = (text: string) => /^Session: (pn-[0-9a-f]{6})$/m.exec(text)?.[1];

describe("plannotator tool on Pi", () => {
	test("registers the shared contract, and the installed Pi validates calls against its schema", () => {
		const harness = createHarness();
		const tool = harness.tool();
		expect(tool.name).toBe(PLANNOTATOR_TOOL_NAME);
		expect(tool.description).toBe(PLANNOTATOR_TOOL_DESCRIPTION);
		expect(tool.parameters).toEqual(PLANNOTATOR_TOOL_INPUT_SCHEMA);
		expect(tool.executionMode).toBe("sequential");

		const validate = (args: unknown) => validateToolArguments(tool as never, { type: "toolCall", id: "t", name: tool.name, arguments: args } as never);
		expect(validate({ action: "annotate", target: "notes.md", gate: true })).toEqual({ action: "annotate", target: "notes.md", gate: true });
		expect(validate({ action: "annotate", target: ["a.md", "b.md"] })).toEqual({ action: "annotate", target: ["a.md", "b.md"] });
		expect(validate({ action: "close", session: "all" })).toEqual({ action: "close", session: "all" });
		expect(() => validate({ action: "annotate", target: "x.md", bogus: 1 })).toThrow();
		expect(() => validate({ action: "explode" })).toThrow();
	});

	test("annotate opens at once with Ask this session attached; feedback arrives later as a followUp naming the session", async () => {
		const harness = createHarness();
		const file = harness.writeFile("notes.md", "# Notes\n\nSome text.\n");
		const result = await harness.call({ action: "annotate", target: "notes.md" });

		expect(result.terminate).toBe(true);
		const text = result.content[0]!.text;
		const id = sessionIdIn(text);
		expect(id).toBeDefined();
		const launch = harness.annotateLaunches[0]!;
		expect(launch.filePath).toBe(file);
		expect(launch.sessionBridge).toBeDefined();
		expect(text).toContain(launch.url);
		expect(harness.sent).toHaveLength(0);

		const posted = await postJson(`${launch.url}/api/feedback`, {
			feedback: "Tighten the intro.",
			annotations: [{ id: "a1", type: "COMMENT", text: "Tighten the intro." }],
		});
		expect(posted.status).toBe(200);
		await until(() => harness.sent.length > 0);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]!.options).toEqual({ deliverAs: "followUp" });
		expect(harness.sent[0]!.text.split("\n")[0]).toBe(`Plannotator: notes.md (${id}) — Feedback · 1 comment.`);
		expect(harness.sent[0]!.text).toContain("Tighten the intro.");
		expect((await harness.call({ action: "list" })).content[0]!.text).toContain("No open Plannotator reviews");
	});

	test("a gated session the tool opened delivers a bare approval", async () => {
		const harness = createHarness();
		harness.writeFile("spec.md", "# Spec\n");
		const result = await harness.call({ action: "annotate", target: "spec.md", gate: true });
		const id = sessionIdIn(result.content[0]!.text);
		const launch = harness.annotateLaunches[0]!;
		expect(launch.gate).toBe(true);

		expect((await postJson(`${launch.url}/api/approve`, {})).status).toBe(200);
		await until(() => harness.sent.length > 0);
		expect(harness.sent[0]!.text.split("\n")[0]).toBe(`Plannotator: spec.md (${id}) — Approved.`);
	});

	test("list and close cover this Pi session's reviews only; close keeps the draft and sends nothing", async () => {
		const harness = createHarness({ sessionId: "pi-session-a" });
		harness.writeFile("notes.md", "# Notes\n");
		const opened = await harness.call({ action: "annotate", target: "notes.md" });
		const id = sessionIdIn(opened.content[0]!.text)!;
		const launch = harness.annotateLaunches[0]!;
		await postJson(`${launch.url}/api/draft`, { annotations: [{ id: "a1" }, { id: "a2" }], codeAnnotations: [], globalAttachments: [] });

		const listed = (await harness.call({ action: "list" })).content[0]!.text;
		expect(listed).toContain(`${id} · annotate · notes.md · ${launch.url}`);
		expect(listed).toContain("unsent: 2");

		// Another Pi session (same process) sees none of it and cannot close it.
		const other = harness.makeCtx("pi-session-b");
		expect((await harness.call({ action: "list" }, other)).content[0]!.text).toContain("No open Plannotator reviews");
		await expect(harness.call({ action: "close", session: id }, other)).rejects.toThrow(`No open Plannotator review ${id}`);
		// Nor does another extension instance.
		const elsewhere = createHarness({ sessionId: "pi-session-a" });
		expect((await elsewhere.call({ action: "list" })).content[0]!.text).toContain("No open Plannotator reviews");

		const closed = (await harness.call({ action: "close", session: id.toUpperCase() })).content[0]!.text;
		expect(closed).toContain(`Closed notes.md (${id}): 2 unsent comments saved as a draft.`);
		// The draft is still on the server, and nothing reaches the agent.
		const draft = await (await fetch(`${launch.url}/api/draft`)).json();
		expect(draft.annotations).toHaveLength(2);
		await until(() => harness.notices.some((notice) => notice.message.includes("the agent closed")));
		expect(harness.notices.some((notice) => notice.message.includes(`the agent closed notes.md (${id}). 2 unsent comments kept in the draft.`))).toBe(true);
		expect(harness.sent).toHaveLength(0);
		expect((await harness.call({ action: "list" })).content[0]!.text).toContain("No open Plannotator reviews");
	});

	test("slash-command reviews are listed too, and close all skips a plan review", async () => {
		const harness = createHarness();
		harness.writeFile("PLAN.md", "# Plan\n\n- [ ] Step\n");
		harness.writeFile("notes.md", "# Notes\n");
		await harness.startSession();
		await harness.command("plannotator-plan-mode", "");
		await harness.tools.get("plannotator_submit_plan")!.execute("p", { filePath: "PLAN.md" }, undefined, undefined, harness.ctx);
		await harness.command("plannotator-annotate", "notes.md");

		const listed = (await harness.call({ action: "list" })).content[0]!.text;
		expect(listed).toContain("2 open Plannotator reviews");
		expect(listed).toContain("· plan · plan PLAN.md ·");
		expect(listed).toContain("· annotate · notes.md ·");
		const planId = /(pn-[0-9a-f]{6}) · plan/.exec(listed)![1]!;

		await expect(harness.call({ action: "close", session: planId })).rejects.toThrow("is a plan review");
		const closedAll = (await harness.call({ action: "close", session: "all" })).content[0]!.text;
		expect(closedAll).toContain("Not closed: plan PLAN.md");
		expect(closedAll).toMatch(/Closed notes\.md \(pn-[0-9a-f]{6}\): no unsent comments\./);
	});

	test("review maps the call to the slash command's arguments", async () => {
		let received: Record<string, unknown> | undefined;
		const harness = createHarness({
			deps: {
				startCodeReview: async (_ctx, reviewOptions) => {
					received = reviewOptions as Record<string, unknown>;
					return { url: "http://localhost:6001", waitForDecision: () => new Promise(() => undefined), stop: () => undefined };
				},
			},
		});
		const result = await harness.call({ action: "review", options: { base: "main" } });
		expect(received).toMatchObject({ defaultBranch: "main", openStateFromFlags: true });
		expect(received!.sessionBridge).toBeDefined();
		expect(result.terminate).toBe(true);
		expect(result.content[0]!.text).toContain("Opened local changes in Plannotator: http://localhost:6001");
	});

	test("refuses what it cannot open: bad calls, file lists, reply, no UI, a missing file", async () => {
		const harness = createHarness();
		await expect(harness.call({ action: "list", target: "x.md" })).rejects.toThrow('action "list" takes no target');
		await expect(harness.call({ action: "annotate", target: ["a.md", "b.md"] })).rejects.toThrow(PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT);
		await expect(harness.call({ action: "reply", session: "pn-abcdef", comment: "c1", text: "done" })).rejects.toThrow(PLANNOTATOR_TOOL_REPLY_UNAVAILABLE_TEXT);
		await expect(harness.call({ action: "annotate", target: "missing.md" })).rejects.toThrow("Plannotator did not open: File not found");
		// One target is one argument: words are never split into a tolerant search.
		harness.writeFile("notes.md", "# Notes\n");
		await expect(harness.call({ action: "annotate", target: "look at notes.md" })).rejects.toThrow("File not found");

		const headless = createHarness({ hasUI: false });
		headless.writeFile("notes.md", "# Notes\n");
		await expect(headless.call({ action: "annotate", target: "notes.md" })).rejects.toThrow("no interactive UI");
		expect(harness.annotateLaunches).toHaveLength(0);
		expect(headless.annotateLaunches).toHaveLength(0);
	});
});
