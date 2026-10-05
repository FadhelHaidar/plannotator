/**
 * OpenCode 1: deliver slash-command feedback through the command's OWN turn.
 *
 * Why this exists. OpenCode 1 runs a command as `command.execute.before`
 * (which Plannotator awaits for the whole review) followed by
 * `prompt({ parts })` on the command's own user message, and `prompt` always
 * runs the model loop: the hook has no way to say "no reply"
 * (`SessionPrompt.command`, `packages/opencode/src/session/prompt.ts` @
 * v1.18.32). Plannotator used to clear `parts` and send the feedback with a
 * separate `session.prompt`, which ran its own loop. The command's emptied
 * message then ran a SECOND loop: its user message has no content, so the
 * model saw a history ending in its own reply and answered the same feedback
 * again. Every command that returned feedback cost two model turns.
 *
 * The fix is to let the command's own message carry the feedback. While a
 * command runs, its handlers get a client whose `session.prompt` to the
 * invoking session is RECORDED instead of sent (`createCommandTurnClient`);
 * the hook then puts that text into `output.parts`, the array OpenCode turns
 * into the command's message, and OpenCode runs exactly one turn for it.
 *
 * The one thing a hook's `parts` cannot say is WHICH agent answers: the
 * command message takes the command's agent (the one the user is on). The
 * feedback may name another one, either the review UI's agent switch or the
 * agent that wrote an annotated message (#1612). That choice is applied in
 * `chat.message`, the hook OpenCode fires while building that very message
 * (`createUserMessage`, same file), by retargeting the message itself
 * (`retargetCommandMessage`). It is what the separate prompt used to do: the
 * reply is written by that agent, on that agent's configured model.
 *
 * A command with nothing to send still runs one turn on an empty message, as
 * before; OpenCode 1 gives a command hook no way to skip it.
 *
 * OpenCode 2 never goes through here: its native commands own the invocation
 * and deliver through `createV2BridgeClient`.
 */

/** Feedback a command produced for its own turn. */
export interface CommandFeedback {
  text: string;
  /** The agent that should answer it, already validated by the handler. */
  agent?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function joinText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is { type: string; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function bindingProxy<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(object, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
      const value = Reflect.get(object, key, object);
      // SDK methods read `this` (the generated client keeps its transport on
      // the instance), so unbound access through the proxy would break them.
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/**
 * A view of `client` whose `session.prompt` to `sessionID` is recorded rather
 * than sent. Everything else (logging, toasts, listing agents and messages,
 * prompts to other sessions, `noReply` prompts) passes straight through.
 */
export function createCommandTurnClient<T>(client: T, sessionID: string | undefined): {
  client: T;
  /** The recorded feedback, once; undefined when nothing was recorded. */
  take: () => CommandFeedback | undefined;
} {
  const recorded: CommandFeedback[] = [];
  const take = (): CommandFeedback | undefined => {
    if (recorded.length === 0) return undefined;
    const entries = recorded.splice(0);
    const agent = entries.map((entry) => entry.agent).filter(Boolean).pop();
    return {
      text: entries.map((entry) => entry.text).join("\n\n"),
      ...(agent && { agent }),
    };
  };

  const session = isRecord(client) ? client.session : undefined;
  if (!sessionID || !isRecord(session) || typeof session.prompt !== "function") {
    return { client, take };
  }
  const send = (session.prompt as (request: unknown) => unknown).bind(session);

  const prompt = async (request: unknown) => {
    const path = isRecord(request) && isRecord(request.path) ? request.path : undefined;
    const body = isRecord(request) && isRecord(request.body) ? request.body : undefined;
    const text = joinText(body?.parts);
    if (path?.id !== sessionID || body?.noReply === true || !text.trim()) {
      return await send(request);
    }
    recorded.push({
      text,
      ...(typeof body?.agent === "string" && body.agent ? { agent: body.agent } : {}),
    });
    return { data: undefined };
  };

  return {
    client: bindingProxy(client as object, {
      session: bindingProxy(session, { prompt }),
    }) as T,
    take,
  };
}

/** Put the recorded feedback into the command's own message. */
export function appendCommandFeedback(parts: unknown[], feedback: CommandFeedback): void {
  parts.push({ type: "text", text: feedback.text });
}

/** An OpenCode 1 agent listing entry, as far as retargeting reads it. */
export interface CommandAgentInfo {
  name?: string;
  model?: { providerID?: string; modelID?: string };
}

/**
 * Point the command's message at the agent the feedback names.
 *
 * Applies only to the message that carries `feedback.text` in `sessionID`, so
 * an unrelated prompt can never be retargeted. Returns whether it applied.
 * When the agent configures a model the message moves to it too, which is
 * what a prompt naming that agent always did (`createUserMessage`:
 * `input.model ?? agent.model ?? current`); the variant belonged to the old
 * model and is dropped with it.
 */
export function retargetCommandMessage(input: {
  sessionID: string;
  feedback: CommandFeedback;
  /** `chat.message`'s own input: the session and the agent OpenCode chose. */
  hook: { sessionID?: unknown; agent?: unknown };
  message: unknown;
  parts: unknown;
  agents?: readonly CommandAgentInfo[];
}): boolean {
  const agent = input.feedback.agent;
  if (!agent || input.hook.sessionID !== input.sessionID || !isRecord(input.message)) return false;
  if (!Array.isArray(input.parts) || !input.parts.some((part) =>
    isRecord(part) && part.type === "text" && part.text === input.feedback.text)) return false;
  // Already that agent: leave the message (and the model the user picked) alone.
  if (input.hook.agent === agent || input.message.agent === agent) return true;

  input.message.agent = agent;
  const model = input.agents?.find((entry) => entry.name === agent)?.model;
  if (model?.providerID && model.modelID) {
    input.message.model = { providerID: model.providerID, modelID: model.modelID };
  }
  return true;
}
