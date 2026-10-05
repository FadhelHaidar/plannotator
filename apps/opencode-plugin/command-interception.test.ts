import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import PlannotatorPlugin from "./index";

/**
 * OpenCode 1 slash-command interception.
 *
 * The V1 plugin clears `output.parts` IN PLACE before anything reaches the
 * model. Now that the shared markdown stubs carry real instructions ("run the
 * plannotator CLI and relay stdout", for OpenCode 2 hosts on the stale
 * channels), a regression here would leak those instructions to the OpenCode 1
 * model and re-open the #713 class: OpenCode resolves prompt parts over
 * "<body> <arguments>" and auto-attaches any file path it finds, which on a
 * large file blows the context before the annotation UI even opens.
 *
 * Interception lives on the always-built plugin object; `shouldRegisterSubmitPlan`
 * only gates `plugin.tool`, so `workflow: "manual"` must intercept too.
 */

const envKeys = ["PLANNOTATOR_BIN", "PLANNOTATOR_DATA_DIR"] as const;
const environment = createTestEnvironment(envKeys, "plannotator-oc1-intercept-");

afterEach(() => environment.restore());

const COMMANDS = ["plannotator-review", "plannotator-annotate", "plannotator-last"] as const;

function makeClient() {
  return {
    app: {
      log: async () => ({}),
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    session: {
      messages: async () => ({ data: [] }),
      prompt: async () => ({}),
    },
  };
}

async function interceptionHandler(options: Record<string, unknown>) {
  const plugin = await PlannotatorPlugin(
    { client: makeClient(), directory: "/project" } as never,
    // "cli" keeps the embedded server out of the test; the CLI spawn then fails
    // fast against the bogus PLANNOTATOR_BIN below and is swallowed by
    // handleCliCommand's own catch.
    { runtime: "cli", ...options } as never,
  );
  return (plugin as Record<string, any>)["command.execute.before"] as (
    input: Record<string, unknown>,
    output: { parts: unknown[] },
  ) => Promise<void>;
}

describe("OpenCode 1 command interception", () => {
  for (const workflow of ["plan-agent", "manual"] as const) {
    for (const command of COMMANDS) {
      test(`${workflow}: /${command} empties output.parts before the model sees it`, async () => {
        environment.reset();
        process.env.PLANNOTATOR_BIN = "/nonexistent/plannotator-interception-test";
        process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();

        const handler = await interceptionHandler({ workflow });
        const parts = [{ type: "text", text: "run the plannotator CLI and relay stdout" }];
        const output = { parts };

        await handler(
          { command, sessionID: "session-1", arguments: "" },
          output,
        );

        expect(parts.length).toBe(0);
        // Mutated in place, never reassigned: the caller holds this exact array
        // and ignores anything assigned to output.parts.
        expect(output.parts).toBe(parts);
      });
    }
  }

  // OpenCode runs a model turn for the command's own message whatever the hook
  // does, so feedback sent as a separate prompt ran a SECOND turn that answered
  // the same review again. Failure caught: the feedback leaving the command's
  // own message (or the named agent being lost on the way).
  test.skipIf(process.platform === "win32")("feedback becomes the command's own message, answered by the agent it names", async () => {
    environment.reset();
    const root = environment.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = root;
    const binary = path.join(root, "fake-cli.ts");
    writeFileSync(binary, `#!/usr/bin/env bun
await Bun.stdin.text();
console.log(JSON.stringify({ decision: "annotated", feedback: "Rename the helper.", agentSwitch: "reviewer" }));
`, { mode: 0o755 });
    process.env.PLANNOTATOR_BIN = binary;

    const client = makeClient();
    const sent: unknown[] = [];
    client.session.prompt = async (request: unknown) => {
      sent.push(request);
      return {};
    };
    client.app.agents = async () => ({
      data: [
        { name: "build", mode: "primary" },
        { name: "reviewer", mode: "primary", model: { providerID: "acme", modelID: "careful-1" } },
      ],
    }) as never;
    const plugin = await PlannotatorPlugin(
      { client, directory: root } as never,
      { runtime: "cli" } as never,
    ) as Record<string, any>;

    const parts: any[] = [{ type: "text", text: "stub body" }];
    await plugin["command.execute.before"](
      { command: "plannotator-review", sessionID: "ses_1", arguments: "" },
      { parts },
    );

    expect(sent).toHaveLength(0);
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain("Rename the helper.");

    // OpenCode then builds the command's message from those parts.
    const message = { agent: "build", model: { providerID: "acme", modelID: "fast-1" } };
    await plugin["chat.message"](
      { sessionID: "ses_1", agent: "build" },
      { message, parts: [{ ...parts[0], id: "prt_1" }] },
    );
    expect(message).toEqual({ agent: "reviewer", model: { providerID: "acme", modelID: "careful-1" } });

    // One-shot: the next message in the session is the user's own.
    const next = { agent: "build", model: { providerID: "acme", modelID: "fast-1" } };
    await plugin["chat.message"](
      { sessionID: "ses_1", agent: "build" },
      { message: next, parts: [{ ...parts[0], id: "prt_2" }] },
    );
    expect(next.agent).toBe("build");
  }, 20_000);

  test("an unrelated command keeps its parts untouched", async () => {
    environment.reset();
    process.env.PLANNOTATOR_BIN = "/nonexistent/plannotator-interception-test";
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();

    const handler = await interceptionHandler({ workflow: "plan-agent" });
    const output = { parts: [{ type: "text", text: "someone else's command" }] };
    await handler({ command: "other-command", sessionID: "session-1", arguments: "" }, output);

    expect(output.parts.length).toBe(1);
  });
});
