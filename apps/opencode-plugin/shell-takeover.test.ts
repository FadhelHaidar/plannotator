import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAnnotateApprovedPrompt } from "@plannotator/shared/prompts";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { handleCliCommand } from "./cli-bridge";
import type { CliCommandRequest } from "./native-commands";
import { registerShellTakeover, SHELL_TOOL_ID, type ShellToolContext } from "./shell-takeover";

// The failure these guard: an agent that runs `plannotator annotate x --gate
// --json` through OpenCode's shell tool blocks its own turn and gets a server
// with no session bridge (Ask AI offers separate AIs), while a command the
// plugin must not touch (a strict gate, a pipeline) stops running as written.

/**
 * A stand-in for OpenCode's tool state: the shell tool is the host's own,
 * and a plugin's `transform` gets an editor whose `update` replaces the tool
 * (core: `update(id, fn)` copies the tool, applies fn, stores the copy).
 */
function makeToolHost() {
  const original = mock(async (input: unknown, _context: ShellToolContext) => ({ ran: input }));
  const tools = new Map<string, { execute: (input: unknown, context: ShellToolContext) => Promise<unknown> }>([
    [SHELL_TOOL_ID, { execute: original }],
  ]);
  const transform = async (callback: (editor: any) => void) => {
    callback({
      update: (id: string, fn: (tool: any) => void) => {
        const tool = tools.get(id);
        if (!tool) return;
        const copy = { ...tool };
        fn(copy);
        tools.set(id, copy);
      },
    });
    return { dispose: async () => {} };
  };
  const shell = (input: unknown, sessionID = "session-1") =>
    tools.get(SHELL_TOOL_ID)!.execute(input, { sessionID } as ShellToolContext);
  return { original, transform, shell };
}

async function setUp(onRun: (request: CliCommandRequest) => Promise<void> | void = (request) => request.onReady?.("http://localhost:4321/")) {
  const host = makeToolHost();
  const requests: CliCommandRequest[] = [];
  const runCommand = mock(async (request: CliCommandRequest) => {
    requests.push(request);
    await onRun(request);
  });
  const ctx: any = {
    tool: { transform: host.transform },
    session: {
      get: async () => ({ location: { directory: "/project" } }),
      prompt: async () => ({}),
    },
    location: { directory: "/fallback" },
  };
  const registered = await registerShellTakeover({
    ctx,
    getAgents: async () => [],
    getBridgeContext: async () => ({ sharingEnabled: true }),
    runCommand,
  });
  return { ...host, requests, registered };
}

function textOf(result: any): string {
  return result.output.output;
}

describe("agent shell calls taken over (OpenCode 2)", () => {
  test("annotate --gate --json opens through the native command path with a session bridge", async () => {
    const { shell, original, requests, registered } = await setUp();
    expect(registered).toBe(true);

    const result: any = await shell({ command: "plannotator annotate docs/INDEX.html --gate --json", description: "open" });

    expect(original).not.toHaveBeenCalled();
    expect(result.output.exit).toBe(0);
    expect(textOf(result)).toContain("Opened INDEX.html in Plannotator: http://localhost:4321/");
    // The gate's promise: an approval comes back as a message.
    expect(textOf(result)).toContain("If they approve, an approval message arrives");
    expect(result.content).toEqual([{ type: "text", text: textOf(result) }]);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.command).toBe("plannotator-annotate");
    expect(request.rawArgs).toBe("docs/INDEX.html --gate");
    expect(request.sessionId).toBe("session-1");
    expect(request.cwd).toBe("/project");
    expect(request.deliverApproval).toBe(true);
    // "Ask this session": the run is given a bridge to the calling session.
    const bridge = request.createSessionBridge?.();
    expect(bridge?.host).toBe("opencode");
    bridge?.dispose?.();
  });

  test("review and last map to their commands; workdir and quoted paths carry through", async () => {
    const { shell, requests } = await setUp();

    await shell({ command: "plannotator review --base main 'my repo'", workdir: "sub" });
    await shell({ command: "plannotator last" });

    expect(requests.map((request) => [request.command, request.rawArgs])).toEqual([
      ["plannotator-review", '--base main "my repo"'],
      ["plannotator-last", ""],
    ]);
    expect(requests[0]!.cwd).toBe(path.resolve("/project", "sub"));
    expect(requests[0]!.deliverApproval).toBeUndefined();
  });

  test("a startup failure is the call's error output, not a hang", async () => {
    const { shell } = await setUp((request) => request.onError?.("File not found: /project/nope.md"));

    const result: any = await shell({ command: "plannotator annotate nope.md" });

    expect(result.output.exit).toBe(1);
    expect(textOf(result)).toContain("File not found: /project/nope.md");
  });

  test("commands the parser refuses run the real shell tool, unchanged", async () => {
    const { shell, original, requests } = await setUp();
    const commands = [
      "plannotator annotate x.md --gate --json --require-approval",
      "plannotator annotate x.md | cat",
      "cd docs && plannotator annotate x.md",
      "ls -la",
    ];
    for (const command of commands) {
      const input = { command, description: "run" };
      expect(await shell(input)).toEqual({ ran: input });
    }
    expect(original).toHaveBeenCalledTimes(commands.length);
    expect(requests).toHaveLength(0);
  });

  test("a host without a tool editor keeps the CLI", async () => {
    const registered = await registerShellTakeover({
      ctx: {} as never,
      getAgents: async () => [],
      getBridgeContext: async () => ({}),
    });
    expect(registered).toBe(false);
  });
});

// The plumbing the take-over relies on, through a real child process.
const environment = createTestEnvironment(
  [
    "PLANNOTATOR_BIN",
    "PLANNOTATOR_DATA_DIR",
    "PLANNOTATOR_TEST_OUTCOME",
    "PLANNOTATOR_TEST_RECORD_FILE",
    "PLANNOTATOR_TEST_READY_URL",
    "PLANNOTATOR_TEST_FAIL",
  ],
  "plannotator-opencode-shell-takeover-",
);
const fixturePath = fileURLToPath(new URL("./fixtures/test-ready-cli.ts", import.meta.url));

afterEach(() => environment.restore());

function prepare(env: Record<string, string>): string {
  environment.reset();
  process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
  const recordFile = path.join(environment.makeTempDir(), "record.json");
  process.env.PLANNOTATOR_BIN = fixturePath;
  process.env.PLANNOTATOR_TEST_RECORD_FILE = recordFile;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return recordFile;
}

function client() {
  return {
    app: { log: mock((_entry: unknown) => {}), agents: mock(async () => ({ data: [] })) },
    session: {
      messages: mock(async (_input: unknown) => ({ data: [] })),
      prompt: mock(async (_input: unknown) => ({})),
    },
  };
}

const fakeBridge = () => ({
  host: "opencode",
  status: () => "ready" as const,
  modes: { turn: true, transient: false },
  ask: async () => {},
});

describe("handleCliCommand: readiness, errors and gated approvals", () => {
  test("reports the server url and launches with a bridge token; a bare gated approval is delivered when asked", async () => {
    const recordFile = prepare({
      PLANNOTATOR_TEST_READY_URL: "http://localhost:4321/",
      PLANNOTATOR_TEST_OUTCOME: JSON.stringify({ decision: "approved" }),
    });
    const host = client();
    const ready: string[] = [];

    await handleCliCommand({
      command: "plannotator-annotate",
      client: host as never,
      sessionId: "session-1",
      rawArgs: "x.html --gate",
      createSessionBridge: fakeBridge as never,
      onReady: (url) => ready.push(url),
      deliverApproval: true,
    });

    expect(ready).toEqual(["http://localhost:4321/"]);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    expect(record.argv).toEqual(["annotate", "x.html", "--json", "--gate"]);
    expect(record.bridgeToken).toBe(true);
    expect(host.session.prompt).toHaveBeenCalledTimes(1);
    const body = (host.session.prompt.mock.calls[0]![0] as { body: { parts: Array<{ text: string }> } }).body;
    expect(body.parts[0]!.text).toBe(getAnnotateApprovedPrompt("opencode"));
  });

  test("without deliverApproval a bare gated approval stays silent, as for the slash command", async () => {
    prepare({
      PLANNOTATOR_TEST_READY_URL: "http://localhost:4321/",
      PLANNOTATOR_TEST_OUTCOME: JSON.stringify({ decision: "approved" }),
    });
    const host = client();

    await handleCliCommand({
      command: "plannotator-annotate",
      client: host as never,
      sessionId: "session-1",
      rawArgs: "x.html --gate",
    });

    expect(host.session.prompt).not.toHaveBeenCalled();
  });

  test("a failing CLI reports its stderr through onError", async () => {
    prepare({ PLANNOTATOR_TEST_FAIL: "File not found: /project/nope.md" });
    const errors: string[] = [];

    await handleCliCommand({
      command: "plannotator-annotate",
      client: client() as never,
      sessionId: "session-1",
      rawArgs: "nope.md",
      onError: (message) => errors.push(message),
    });

    expect(errors).toEqual(["File not found: /project/nope.md"]);
  });
});
