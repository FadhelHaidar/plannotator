import { describe, expect, mock, test } from "bun:test";
import {
  appendCommandFeedback,
  createCommandTurnClient,
  resolveFeedbackTarget,
  retargetCommandMessage,
} from "./command-turn";

class FakeSession {
  constructor(readonly transport: { sent: unknown[] }) {}
  // Reads `this`, like the generated SDK class: the proxy must keep it bound.
  async prompt(request: unknown) {
    this.transport.sent.push(request);
    return { data: "sent" };
  }
  async messages() {
    return { data: this.transport.sent };
  }
}

function makeClient() {
  const transport = { sent: [] as unknown[] };
  return {
    transport,
    client: {
      session: new FakeSession(transport),
      app: { log: mock((_entry: unknown) => {}) },
    },
  };
}

function prompt(id: string, text: string, extra: Record<string, unknown> = {}) {
  return { path: { id }, body: { ...extra, parts: [{ type: "text", text }] } };
}

describe("createCommandTurnClient", () => {
  // Failure caught: feedback for the invoking session reaching OpenCode as its
  // own prompt again, which is what ran a second model turn per command.
  test("records the invoking session's feedback instead of sending it", async () => {
    const { client, transport } = makeClient();
    const turn = createCommandTurnClient(client, "ses_1");

    await turn.client.session.prompt(prompt("ses_1", "Fix the header.", { agent: "build" }));

    expect(transport.sent).toHaveLength(0);
    expect(turn.take()).toEqual({ text: "Fix the header.", agent: "build" });
    expect(turn.take()).toBeUndefined();
  });

  test("passes through everything that is not this command's feedback", async () => {
    const { client, transport } = makeClient();
    const turn = createCommandTurnClient(client, "ses_1");

    await turn.client.session.prompt(prompt("ses_other", "elsewhere"));
    await turn.client.session.prompt(prompt("ses_1", "handoff", { noReply: true }));
    await turn.client.session.prompt(prompt("ses_1", "   "));
    // Unrelated members keep working, bound to the real object.
    expect((await turn.client.session.messages()).data).toHaveLength(3);
    turn.client.app.log({ level: "info", message: "x" });

    expect(transport.sent).toHaveLength(3);
    expect(client.app.log).toHaveBeenCalledTimes(1);
    expect(turn.take()).toBeUndefined();
  });

  test("without a session id nothing is intercepted", async () => {
    const { client, transport } = makeClient();
    const turn = createCommandTurnClient(client, undefined);

    expect(turn.client).toBe(client);
    await turn.client.session.prompt(prompt("ses_1", "x"));
    expect(transport.sent).toHaveLength(1);
  });

  test("appends to the command's own parts array in place", () => {
    const parts: unknown[] = [];
    appendCommandFeedback(parts, { text: "Feedback" });
    expect(parts).toEqual([{ type: "text", text: "Feedback" }]);
  });
});

// What OpenCode 1 did with the OLD separate feedback prompt
// (`session.prompt({ agent?, parts })`: no model, no variant), transcribed from
// `createUserMessage` in packages/opencode/src/session/prompt.ts @ v1.18.32
// (Agent.defaultInfo from packages/opencode/src/agent/agent.ts). The new path
// must land on exactly this agent/model/variant; only the turn count changes.
interface HostAgent {
  name: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  model?: { providerID: string; modelID: string };
  variant?: string;
}
interface Host {
  agents: HostAgent[]; // object order == GET /agent order in these fixtures
  defaultAgent?: string;
  sessionModel?: { providerID: string; modelID: string };
  variants: Record<string, string[]>; // "provider/model" -> offered variants
}
function oldPromptMessage(host: Host, agentName: string | undefined) {
  const ag = agentName
    ? host.agents.find((a) => a.name === agentName)!
    : host.defaultAgent
      ? host.agents.find((a) => a.name === host.defaultAgent)!
      : host.agents.find((a) => a.mode !== "subagent" && a.hidden !== true)!;
  const model = ag.model ?? host.sessionModel!;
  const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID;
  const offered = host.variants[`${model.providerID}/${model.modelID}`];
  const variant = ag.variant && same && offered?.includes(ag.variant) ? ag.variant : undefined;
  return { agent: ag.name, model: { providerID: model.providerID, modelID: model.modelID, ...(variant && { variant }) } };
}

function newCommandMessage(
  host: Host,
  namedAgent: string | undefined,
  commandMessage: { agent: string; model: { providerID: string; modelID: string; variant?: string } },
) {
  const target = resolveFeedbackTarget({
    namedAgent,
    agents: host.agents,
    defaultAgent: host.defaultAgent,
    sessionModel: host.sessionModel,
    modelVariants: (model) => host.variants[`${model.providerID}/${model.modelID}`] ?? [],
  });
  expect(target).toBeDefined();
  const message = structuredClone(commandMessage) as Record<string, unknown>;
  const applied = retargetCommandMessage({
    sessionID: "ses_1",
    pending: { text: "Feedback body", target: target! },
    hook: { sessionID: "ses_1" },
    message,
    parts: [{ type: "text", text: "Feedback body", id: "prt_1" }],
  });
  expect(applied).toBe(true);
  return message;
}

const HOST: Host = {
  agents: [
    { name: "build", mode: "primary" },
    { name: "plan", mode: "primary", model: { providerID: "acme", modelID: "think-2" }, variant: "high" },
    { name: "reviewer", mode: "primary", model: { providerID: "acme", modelID: "careful-1" }, variant: "max" },
    { name: "writer", mode: "primary", variant: "high" },
    { name: "explore", mode: "subagent" },
    { name: "title", mode: "primary", hidden: true },
  ],
  sessionModel: { providerID: "acme", modelID: "everyday-1" },
  variants: { "acme/think-2": ["low", "high"], "acme/careful-1": ["low"], "acme/everyday-1": ["high"] },
};

// The command's own message as OpenCode builds it: the TUI's agent, and the
// model + variant the user picked in the TUI.
const TUI_MESSAGE = { agent: "build", model: { providerID: "acme", modelID: "tui-pick", variant: "high" } };

describe("feedback answered by the same agent/model/variant as the old separate prompt", () => {
  const cases: Array<[string, Host, string | undefined, typeof TUI_MESSAGE]> = [
    // Review UI agent switch to an agent with a model and an offered variant.
    ["review agent switch: model and variant carried", HOST, "plan", TUI_MESSAGE],
    // #1612: the annotated message's writer; its variant is not offered by its
    // model, so the old prompt dropped it.
    ["annotated-message writer: unoffered variant dropped", HOST, "reviewer", TUI_MESSAGE],
    // A named agent with no model answers on the session's model, no variant.
    ["named agent without a model: session model, no variant", HOST, "writer", TUI_MESSAGE],
    // No agent named (review feedback without a switch, or an unresolvable /
    // subagent writer): OpenCode's default agent answered.
    ["no agent: default agent on the session model", HOST, undefined, { ...TUI_MESSAGE, agent: "plan" }],
    ["no agent: configured default_agent", { ...HOST, defaultAgent: "plan" }, undefined, TUI_MESSAGE],
    // Routed agent == the command's agent: the agent's configured model, not
    // the TUI pick.
    ["routed agent equals the current agent", HOST, "plan", { ...TUI_MESSAGE, agent: "plan" }],
  ];

  for (const [name, host, named, command] of cases) {
    test(name, () => {
      expect(newCommandMessage(host, named, command)).toEqual(oldPromptMessage(host, named));
    });
  }

  test("an unreadable model listing keeps the agent's own configured variant", () => {
    const target = resolveFeedbackTarget({ namedAgent: "plan", agents: HOST.agents, modelVariants: () => undefined });
    expect(target?.variant).toBe("high");
  });

  test("an unknown agent leaves the command's message as OpenCode built it", () => {
    expect(resolveFeedbackTarget({ namedAgent: "gone", agents: HOST.agents })).toBeUndefined();
  });
});

describe("retargetCommandMessage", () => {
  const pending = { text: "Feedback body", target: { agent: "plan", model: { providerID: "acme", modelID: "think-2" } } };

  test("never touches another message or another session", () => {
    const cases = [
      { hook: { sessionID: "ses_1" }, parts: [{ type: "text", text: "something the user typed" }] },
      { hook: { sessionID: "ses_2" }, parts: [{ type: "text", text: "Feedback body" }] },
    ];
    for (const { hook, parts } of cases) {
      const message = structuredClone(TUI_MESSAGE);
      expect(retargetCommandMessage({ sessionID: "ses_1", pending, hook, message, parts })).toBe(false);
      expect(message).toEqual(TUI_MESSAGE);
    }
  });

  test("with no resolvable model it keeps the message's model but not its TUI variant", () => {
    const message = structuredClone(TUI_MESSAGE) as Record<string, unknown>;
    retargetCommandMessage({
      sessionID: "ses_1",
      pending: { text: "Feedback body", target: { agent: "build" } },
      hook: { sessionID: "ses_1" },
      message,
      parts: [{ type: "text", text: "Feedback body" }],
    });
    expect(message).toEqual({ agent: "build", model: { providerID: "acme", modelID: "tui-pick" } });
  });
});
