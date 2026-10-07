import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

/**
 * Coverage for the compact progress tracker: widget layout, the
 * /plannotator-tracker command, preference persistence, and todo-mirror
 * enforcement while the tracker is hidden. The harness mirrors
 * todo-provider-sync.test.ts; PLANNOTATOR_DATA_DIR is sandboxed because the
 * tracker command persists its preference through the shared config writer.
 */
const tempDirs: string[] = [];
let originalDataDir: string | undefined;

beforeEach(() => {
	originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	if (originalDataDir !== undefined) process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
	else delete process.env.PLANNOTATOR_DATA_DIR;
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createHarness(cwd: string, dataDir: string) {
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const notifications: string[] = [];
	const widgets: Array<string[] | undefined> = [];

	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(tool.name, tool),
		getFlag: () => true,
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	};

	const ctx = {
		cwd,
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		model: { provider: "test", id: "original-model" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "test-session",
			getSessionFile: () => "session.json",
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			setWidget: (_key: string, content: unknown) => {
				// The widget may be lines (legacy) or a component factory (current).
				if (content === undefined) widgets.push(undefined);
				else if (Array.isArray(content)) widgets.push(content);
				else if (typeof content === "function") {
					const component = (content as (tui: unknown, theme: unknown) => { render: (width: number) => string[] })(
						undefined,
					{ fg: (_color: string, text: string) => text },
					);
					widgets.push(component.render(80));
				} else widgets.push((content as { render: (width: number) => string[] }).render(80));
			},
			theme: {
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};

	return {
		ctx,
		commands,
		notifications,
		widgets,
		async startSession(): Promise<void> {
			plannotator(pi as never);
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
		},
		submitPlan(filePath: string) {
			return tools
				.get("plannotator_submit_plan")!
				.execute("call-1", { filePath }, undefined, undefined, ctx);
		},
		markStepDone(step: number) {
			return tools
				.get("plannotator_mark_done")!
				.execute("call-2", { step }, undefined, undefined, ctx);
		},
		tracker(args: string) {
			return commands.get("plannotator-tracker")!.handler(args, ctx);
		},
		/** The `/plannotator-plan-mode` toggle is the shared exit back to idle. */
		async toggle(): Promise<void> {
			await commands.get("plannotator-plan-mode")?.handler("", ctx);
		},
	};
}

const renderLast = (widgets: Array<string[] | undefined>) =>
	widgets.filter((content): content is string[] => Array.isArray(content)).at(-1);

const readTodos = (todosDir: string): Array<{ title: string; status: string }> => {
	if (!existsSync(todosDir)) return [];
	return readdirSync(todosDir)
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => {
			const content = readFileSync(join(todosDir, entry), "utf8");
			const end = content.indexOf("\n}");
			const parsed = JSON.parse(content.slice(0, end + 2)) as { title: string; status: string };
			return { title: parsed.title, status: parsed.status };
		});
};

describe("compact progress tracker", () => {
	test("renders summary plus pending steps only, capped at five rows", async () => {
		const cwd = makeTempDir("plannotator-tracker-");
		const dataDir = makeTempDir("plannotator-tracker-data-");
		const plan = ["# Plan", ""];
		for (let i = 1; i <= 8; i++) plan.push(`- [ ] Step ${i}`);
		writeFileSync(join(cwd, "PLAN.md"), plan.join("\n") + "\n");

		const harness = createHarness(cwd, dataDir);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");

		const rendered = renderLast(harness.widgets)!;
		expect(rendered[0]).toBe("Plan: 0/8 complete");
		expect(rendered).toHaveLength(5);
		expect(rendered[1]).toBe("☐ 1. Step 1");
		expect(rendered.at(-1)).toBe("… 5 more pending");

		await harness.markStepDone(8);
		const updated = renderLast(harness.widgets)!;
		expect(updated[0]).toBe("Plan: 1/8 complete");
		expect(updated).toHaveLength(5);
	});

	test("toggle off clears the widget, persists the preference, and keeps syncing todos", async () => {
		const cwd = makeTempDir("plannotator-tracker-");
		const dataDir = makeTempDir("plannotator-tracker-data-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] First step\n- [ ] Second step\n");

		const harness = createHarness(cwd, dataDir);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		expect(renderLast(harness.widgets)).toHaveLength(3);

		await harness.tracker("off");
		expect(harness.widgets.at(-1)).toBeUndefined();
		// Footer (setStatus) is untouched by the harness's no-op; provider sync continues.
		await harness.markStepDone(1);
		expect(harness.widgets.at(-1)).toBeUndefined();
		const todos = readTodos(todosDir);
		expect(todos.find((todo) => todo.title === "1. First step")?.status).toBe("done");
		expect(todos.find((todo) => todo.title === "2. Second step")?.status).toBe("open");
		// Preference persisted through the shared writer.
		const saved = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
		expect(saved.piProgressWidgetMode).toBe("off");
	});

	test("toggle on restores the widget; on/off are idempotent; status and usage behave", async () => {
		const cwd = makeTempDir("plannotator-tracker-");
		const dataDir = makeTempDir("plannotator-tracker-data-");
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Only step\n");

		const harness = createHarness(cwd, dataDir);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");

		await harness.tracker("off");
		await harness.tracker("off"); // idempotent: still hidden, no surface-change notice spam
		expect(harness.widgets.at(-1)).toBeUndefined();

		await harness.tracker("on");
		expect(renderLast(harness.widgets)).toEqual(["Plan: 0/1 complete", "☐ 1. Only step"]);

		const before = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
		await harness.tracker("status");
		expect(harness.notifications.at(-1)).toContain("compact");
		await harness.tracker("bogus");
		expect(harness.notifications.at(-1)).toContain("Usage");
		// status and invalid args write nothing.
		expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))).toEqual(before);
	});

	test("hidden tracker enforces the todo mirror even when configured off", async () => {
		const cwd = makeTempDir("plannotator-tracker-");
		const dataDir = makeTempDir("plannotator-tracker-data-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		// The mirror is configured off in the shared config...
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ todoProvider: "off" }));
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Enforced step\n");

		const harness = createHarness(cwd, dataDir);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		// ...visible tracker respects it: no mirror.
		expect(readTodos(todosDir)).toEqual([]);

		// Hiding the tracker must not disable tracking: the mirror is enforced.
		await harness.tracker("off");
		expect(
			harness.notifications.some((note) => note.includes("even if it was configured off")),
		).toBe(true);
		await harness.markStepDone(1);
		const todos = readTodos(todosDir);
		expect(todos.map((todo) => todo.title)).toEqual(["1. Enforced step"]);
		expect(todos[0]!.status).toBe("done");
	});

	test("hidden tracker without any todo tool says so honestly", async () => {
		const cwd = makeTempDir("plannotator-tracker-");
		const dataDir = makeTempDir("plannotator-tracker-data-");
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Lone step\n");

		const harness = createHarness(cwd, dataDir);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.tracker("off");

		expect(
			harness.notifications.some((note) => note.includes("no todo-list tool detected")),
		).toBe(true);
		expect(existsSync(join(cwd, ".pi", "todos"))).toBe(false);
	});

	test("preference persists across sessions and defaults to visible", async () => {
		const cwd = makeTempDir("plannotator-tracker-");
		const dataDir = makeTempDir("plannotator-tracker-data-");
		writeFileSync(join(cwd, "PLAN.md"), "# Plan\n\n- [ ] Step\n");

		const first = createHarness(cwd, dataDir);
		await first.startSession();
		await first.submitPlan("PLAN.md");
		await first.tracker("off");
		await first.toggle();

		// Second session boots with the saved preference: no widget, sync intact.
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		const second = createHarness(cwd, dataDir);
		await second.startSession();
		await second.submitPlan("PLAN.md");
		expect(second.widgets.filter((content) => content !== undefined)).toEqual([]);
		await second.markStepDone(1);
		expect(readTodos(todosDir)[0]!.status).toBe("done");
	});
});
