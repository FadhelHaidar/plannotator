/**
 * An agent's `bash` call running `plannotator annotate|review|last` is
 * answered by the extension through the same in-process open paths as the
 * slash commands, instead of running the blocking CLI.
 *
 * What regresses if this fails:
 *  - an agent that reaches for the CLI blocks its own session until the
 *    reviewer decides, and Ask AI there offers a separate AI instead of this
 *    session (the bug that motivated the take-over);
 *  - a command that must run as written (a strict gate, a pipeline, `cd x &&`)
 *    is swallowed and opened as something else;
 *  - an agent told to wait for a gate's sign-off never receives a bare approval;
 *  - the new module is missing from the npm package and the extension fails to load.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator, { type PlannotatorExtensionDeps } from "./index.ts";

const tempDirs: string[] = [];
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_REMOTE"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-takeover-data-");
	process.env.PLANNOTATOR_REMOTE = "0";
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

type Decision = { feedback: string; approved?: boolean; exit?: boolean };

interface Opened {
	kind: "annotate" | "review" | "last";
	args: unknown[];
	decide: (decision: Decision) => void;
}

function createHarness(cwd: string) {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sentUserMessages: Array<{ text: string; options: unknown }> = [];
	const opened: Opened[] = [];

	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: () => undefined,
		getFlag: () => false,
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getCommands: () => [],
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: (text: string, options: unknown) => sentUserMessages.push({ text, options }),
	};

	const branch = [
		{ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "text", text: "Here is my summary." }] } },
	];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	};

	const fakeSession = (kind: Opened["kind"], args: unknown[]) => {
		let decide!: (decision: Decision) => void;
		const decision = new Promise<Decision>((resolve) => {
			decide = resolve;
		});
		opened.push({ kind, args, decide });
		return { url: `http://localhost:${5000 + opened.length}`, waitForDecision: () => decision } as never;
	};

	const deps: PlannotatorExtensionDeps = {
		hasPlanBrowserHtml: () => true,
		hasReviewBrowserHtml: () => true,
		startMarkdownAnnotation: async (...args) => fakeSession("annotate", args),
		startCodeReview: async (...args) => fakeSession("review", args),
		startLastMessageAnnotation: async (...args) => fakeSession("last", args),
	};

	return {
		ctx,
		opened,
		sentUserMessages,
		async start() {
			plannotator(pi as never, deps);
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		},
		/** Every tool_call handler's answer for a bash call, as Pi would gather it. */
		async bash(command: string) {
			for (const handler of handlers.get("tool_call") ?? []) {
				const result = await handler({ type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command } }, ctx);
				if (result) return result as { block?: boolean; reason?: string; terminate?: boolean };
			}
			return undefined;
		},
		command(name: string, args: string) {
			return commands.get(name)!.handler(args, ctx);
		},
		async settle(until: () => boolean) {
			for (let i = 0; i < 50 && !until(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		},
	};
}

async function startedSession() {
	const cwd = makeTempDir("plannotator-takeover-");
	writeFileSync(join(cwd, "INDEX.html"), "<html><body><h1>Report</h1></body></html>");
	writeFileSync(join(cwd, "notes.md"), "# Notes\n");
	const harness = createHarness(cwd);
	await harness.start();
	return { cwd, harness };
}

describe("agent-run plannotator commands", () => {
	test("annotate --gate --json opens in-process with this session's bridge and ends the turn", async () => {
		const { cwd, harness } = await startedSession();
		const answer = await harness.bash("plannotator annotate INDEX.html --gate --json");

		expect(answer?.block).toBe(true);
		expect(answer?.terminate).toBe(true);
		expect(answer?.reason).toContain("http://localhost:5001");
		expect(answer?.reason).toContain("INDEX.html");
		expect(harness.opened).toHaveLength(1);
		const [only] = harness.opened;
		expect(only!.kind).toBe("annotate");
		// startMarkdownAnnotationSession(ctx, path, markdown, mode, folder, sourceInfo, converted, gate, rawHtml, renderHtml, convertHtml, recent, liveUrl, bridge)
		expect(only!.args[1]).toBe(join(cwd, "INDEX.html"));
		expect(only!.args[7]).toBe(true);
		expect(only!.args[8]).toContain("<h1>Report</h1>");
		expect(only!.args[13]).toBeDefined();
	});

	test("a gate the agent opened delivers a bare approval; the slash command only notifies", async () => {
		const { harness } = await startedSession();
		await harness.bash("plannotator annotate notes.md --gate");
		await harness.command("plannotator-annotate", "notes.md --gate");
		const [agentGate, commandGate] = harness.opened;

		agentGate!.decide({ feedback: "", approved: true });
		await harness.settle(() => harness.sentUserMessages.length > 0);
		expect(harness.sentUserMessages).toHaveLength(1);
		expect(harness.sentUserMessages[0]!.options).toEqual({ deliverAs: "followUp" });

		commandGate!.decide({ feedback: "", approved: true });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.sentUserMessages).toHaveLength(1);
	});

	test("review and last take the same paths as their commands", async () => {
		const { harness } = await startedSession();
		const review = await harness.bash("plannotator review --base main");
		const last = await harness.bash("plannotator last");

		expect(review?.terminate).toBe(true);
		expect(last?.terminate).toBe(true);
		expect(harness.opened.map((entry) => entry.kind)).toEqual(["review", "last"]);
		expect(harness.opened[0]!.args[1]).toMatchObject({ defaultBranch: "main", openStateFromFlags: true });
		expect(harness.opened[0]!.args[1]).toHaveProperty("sessionBridge");
		expect(harness.opened[1]!.args[1]).toBe("Here is my summary.");
	});

	test("an open error is the call's answer and does not end the turn", async () => {
		const { harness } = await startedSession();
		const answer = await harness.bash("plannotator annotate missing.md");

		expect(answer?.block).toBe(true);
		expect(answer?.terminate).toBeUndefined();
		expect(answer?.reason).toContain("File not found");
		expect(harness.opened).toHaveLength(0);
	});

	test("commands the parser does not take over run as written", async () => {
		const { harness } = await startedSession();
		for (const command of [
			"plannotator annotate notes.md --gate --json --require-approval",
			"plannotator annotate notes.md | cat",
			"cd docs && plannotator annotate notes.md",
			"plannotator archive",
			"ls -la",
		]) {
			expect([command, await harness.bash(command)]).toEqual([command, undefined]);
		}
		expect(harness.opened).toHaveLength(0);
	});

	test("a session that cannot open a browser lets the command run", async () => {
		const { harness } = await startedSession();
		(harness.ctx as { hasUI: boolean }).hasUI = false;
		expect(await harness.bash("plannotator annotate notes.md")).toBeUndefined();
		expect(harness.opened).toHaveLength(0);
	});
});

test("the npm package ships every hand-written module index.ts imports", () => {
	const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8")) as { files: string[] };
	const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
	const local = [...source.matchAll(/from "\.\/([\w-]+\.ts)"/g)].map((match) => match[1]!);
	expect(local).toContain("agent-command-takeover.ts");
	expect(local.filter((file) => !manifest.files.includes(file))).toEqual([]);
});
