import { describe, expect, mock, test } from "bun:test";
import {
  appendCommandFeedback,
  createCommandTurnClient,
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

describe("retargetCommandMessage", () => {
  const feedback = { text: "Feedback body", agent: "reviewer" };
  const agents = [
    { name: "build" },
    { name: "reviewer", model: { providerID: "acme", modelID: "careful-1" } },
  ];

  function commandMessage() {
    return {
      agent: "build",
      model: { providerID: "acme", modelID: "fast-1", variant: "high" },
    };
  }

  // Failure caught: the reply coming from the command's agent when the review
  // UI's agent switch or the annotated message's writer (#1612) named another.
  test("points the message carrying the feedback at the named agent and its model", () => {
    const message = commandMessage();
    const applied = retargetCommandMessage({
      sessionID: "ses_1",
      feedback,
      hook: { sessionID: "ses_1", agent: "build" },
      message,
      parts: [{ type: "text", text: "Feedback body", id: "prt_1" }],
      agents,
    });

    expect(applied).toBe(true);
    expect(message).toEqual({ agent: "reviewer", model: { providerID: "acme", modelID: "careful-1" } });
  });

  test("an agent with no configured model keeps the message's model", () => {
    const message = commandMessage();
    retargetCommandMessage({
      sessionID: "ses_1",
      feedback: { text: "Feedback body", agent: "plain" },
      hook: { sessionID: "ses_1", agent: "build" },
      message,
      parts: [{ type: "text", text: "Feedback body" }],
      agents: [...agents, { name: "plain" }],
    });

    expect(message.agent).toBe("plain");
    expect(message.model).toEqual(commandMessage().model);
  });

  test("never touches another message, another session, or the same agent", () => {
    const cases = [
      { hook: { sessionID: "ses_1", agent: "build" }, parts: [{ type: "text", text: "something the user typed" }] },
      { hook: { sessionID: "ses_2", agent: "build" }, parts: [{ type: "text", text: "Feedback body" }] },
      { hook: { sessionID: "ses_1", agent: "reviewer" }, parts: [{ type: "text", text: "Feedback body" }] },
    ];
    for (const { hook, parts } of cases) {
      const message = commandMessage();
      retargetCommandMessage({ sessionID: "ses_1", feedback, hook, message, parts, agents });
      expect(message).toEqual(commandMessage());
    }
  });
});
