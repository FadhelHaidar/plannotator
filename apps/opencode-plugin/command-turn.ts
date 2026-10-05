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
 * The one thing a hook's `parts` cannot say is WHO answers: the command's
 * message takes the command's agent and model (the ones the user is on). The
 * separate prompt named the agent the feedback was for (the review UI's agent
 * switch, or the agent that wrote an annotated message, #1612) or, when there
 * was none, no agent at all, so OpenCode's default agent answered; either way
 * on that agent's configured model and variant. `resolveFeedbackTarget`
 * computes exactly that when the feedback is delivered, and
 * `retargetCommandMessage` applies it in `chat.message`, the hook OpenCode
 * fires while building the command's message (`createUserMessage`, same
 * file). Only the turn count changes.
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

/** A model reference as OpenCode 1 user messages carry it. */
export interface CommandModelRef {
  providerID: string;
  modelID: string;
}

/** An OpenCode 1 agent listing entry (`GET /agent`), as far as routing reads it. */
export interface CommandAgentInfo {
  name?: string;
  mode?: string;
  hidden?: boolean;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
}

/** Who answers the feedback, on which model and variant. */
export interface FeedbackTarget {
  agent: string;
  /** Undefined when the host could not say; the message keeps its model then. */
  model?: CommandModelRef;
  variant?: string;
}

function modelRef(value: unknown): CommandModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const modelID = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : undefined;
  if (typeof value.providerID !== "string" || !value.providerID || !modelID) return undefined;
  return { providerID: value.providerID, modelID };
}

/**
 * Resolve what OpenCode 1 would have used for a prompt naming `namedAgent`
 * (or no agent) with no model and no variant: the shape of every feedback
 * prompt this plugin used to send. Mirrors `createUserMessage`
 * (`packages/opencode/src/session/prompt.ts` @ v1.18.32):
 *
 *  - agent: the named one, else `Agent.defaultInfo()`: `default_agent` from
 *    config, else the first primary, non-hidden agent (the host's `GET /agent`
 *    lists that one first: it sorts `default_agent`, else `build`, to the top);
 *  - model: `agent.model ?? currentModel(session)`, where `currentModel` is
 *    the session's stored model, else the last user message's;
 *  - variant: the agent's `variant`, only when the agent configures a model
 *    and that model offers the variant (`full?.variants?.[agent.variant]`).
 *    `modelVariants` answers that; undefined there means the host could not
 *    list models, and the agent's own configured variant is kept.
 *
 * Returns undefined when the agent cannot be resolved, in which case the
 * command's message is left exactly as OpenCode built it.
 */
export function resolveFeedbackTarget(input: {
  namedAgent?: string;
  agents: readonly CommandAgentInfo[];
  /** `default_agent` from the OpenCode config, when set. */
  defaultAgent?: string;
  /** The session's current model before the command's message was created. */
  sessionModel?: CommandModelRef;
  modelVariants?: (model: CommandModelRef) => readonly string[] | undefined;
}): FeedbackTarget | undefined {
  const agent = input.namedAgent
    ? input.agents.find((entry) => entry.name === input.namedAgent)
    : input.defaultAgent
      ? input.agents.find((entry) => entry.name === input.defaultAgent)
      : input.agents.find((entry) => entry.mode !== "subagent" && entry.hidden !== true);
  if (!agent?.name) return undefined;

  const agentModel = modelRef(agent.model);
  let variant: string | undefined;
  if (agentModel && agent.variant) {
    const offered = input.modelVariants?.(agentModel);
    variant = offered === undefined || offered.includes(agent.variant) ? agent.variant : undefined;
  }
  const model = agentModel ?? input.sessionModel;
  return {
    agent: agent.name,
    ...(model && { model }),
    ...(variant && { variant }),
  };
}

/** Feedback waiting for its message, with the target resolved at delivery time. */
export interface PendingCommandFeedback {
  text: string;
  target: FeedbackTarget;
}

/**
 * Give the command's message the agent, model and variant the feedback prompt
 * would have had (`resolveFeedbackTarget`), so moving the feedback into the
 * command's own turn changes nothing but the number of turns.
 *
 * Applies only to the message that carries `pending.text` in `sessionID`, so
 * an unrelated prompt can never be retargeted. Returns whether it applied.
 */
export function retargetCommandMessage(input: {
  sessionID: string;
  pending: PendingCommandFeedback;
  /** `chat.message`'s own input. */
  hook: { sessionID?: unknown };
  message: unknown;
  parts: unknown;
}): boolean {
  if (input.hook.sessionID !== input.sessionID || !isRecord(input.message)) return false;
  if (!Array.isArray(input.parts) || !input.parts.some((part) =>
    isRecord(part) && part.type === "text" && part.text === input.pending.text)) return false;

  const { target } = input.pending;
  const model = target.model ?? modelRef(input.message.model);
  input.message.agent = target.agent;
  if (model) {
    input.message.model = {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(target.variant && { variant: target.variant }),
    };
  }
  return true;
}
