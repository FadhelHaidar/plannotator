/**
 * An agent's own `plannotator annotate|review|last` shell call, answered by
 * the plugin instead of the blocking CLI (OpenCode 2).
 *
 * When the agent runs the CLI itself through the shell tool, the call holds
 * the turn until the reviewer decides and the server it starts has no session
 * bridge, so Ask AI offers separate AIs instead of this session. This module
 * wraps the built-in shell tool's `execute` (the documented
 * `ctx.tool.transform` -> `editor.update` seam): a command that
 * `plannotatorCommandToToolInput` (packages/shared/plannotator-tool.ts) takes
 * over opens through the SAME path the native `/plannotator-*` commands use
 * (`runNativeCommand` -> `handleCliCommand`: pull bridge to this session,
 * feedback delivered later as a prompt), and the call returns at once with the
 * `plannotator` tool's opened text. Every other command runs the original
 * shell tool, untouched.
 *
 * Why a wrapper and not a hook: `tool.hook("execute.before")` can only mutate
 * the input (the host resolves the tool before the hook and reads back only
 * `input`), so it cannot answer a call; `execute.after` runs after the command
 * already ran. Replacing `execute` through the tool editor is the one seam that
 * lets the plugin answer the call itself.
 */

import path from "node:path";
import {
  plannotatorCommandToToolInput,
  plannotatorToolArgs,
  plannotatorToolOpenedText,
  plannotatorToolSubject,
  type PlannotatorToolInput,
} from "@plannotator/shared/plannotator-tool";
import { resolveDirectory, runNativeCommand, type NativeCommandDeps } from "./native-commands";

/** The built-in shell tool's id on OpenCode 2 (`opencode.tool.shell`). */
export const SHELL_TOOL_ID = "shell";

/** How long the call waits for the page before answering "starting". */
const READY_WAIT_MS = { review: 45_000, other: 15_000 } as const;

const NATIVE_COMMAND_FOR: Record<PlannotatorToolInput["action"], string> = {
  annotate: "plannotator-annotate",
  review: "plannotator-review",
  last: "plannotator-last",
};

type ToolExecute = (input: unknown, context: ShellToolContext) => Promise<unknown>;

export interface ShellToolContext {
  readonly sessionID: string;
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

interface ShellToolEditor {
  update?: (id: string, update: (tool: { execute: ToolExecute }) => void) => void;
}

export type ShellTakeoverContext = NativeCommandDeps["ctx"] & {
  tool?: { transform?: (callback: (editor: ShellToolEditor) => void) => Promise<unknown> };
};

export interface ShellTakeoverDeps extends NativeCommandDeps {
  ctx: ShellTakeoverContext;
}

/** The shell tool's result: its declared output (`output`, `truncated`, `exit`, `status`) plus the text the model reads. */
export function shellToolResult(text: string, exit: number) {
  return {
    output: { output: text, truncated: false, exit, status: "completed" as const },
    content: [{ type: "text" as const, text }],
    metadata: { status: "completed", exit },
  };
}

/** The `plannotator` tool input a shell call's `command` stands for, or null. */
export function shellCallToolInput(input: unknown): PlannotatorToolInput | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? plannotatorCommandToToolInput(command) : null;
}

/** One argument in the raw text the native command parsers split again (both read quotes). */
function quoteArg(word: string): string {
  if (!/\s/.test(word)) return word;
  return word.includes('"') ? `'${word}'` : `"${word}"`;
}

type StartOutcome = { url: string } | { error: string } | { pending: true };

/**
 * Open what `call` names through the native command path and answer the shell
 * call once the page is open (or failed, or is still starting after the wait).
 */
export async function takeOverShellCall(
  call: PlannotatorToolInput,
  input: { workdir?: unknown },
  context: ShellToolContext,
  deps: NativeCommandDeps,
): Promise<ReturnType<typeof shellToolResult>> {
  const sessionID = context.sessionID;
  const subject = plannotatorToolSubject(call);
  const gate = call.gate === true;
  const cwd = typeof input.workdir === "string" && input.workdir
    ? path.resolve(await resolveDirectory(deps.ctx, sessionID), input.workdir)
    : undefined;

  let settle: (outcome: StartOutcome) => void = () => {};
  const started = new Promise<StartOutcome>((resolve) => {
    settle = resolve;
  });
  void runNativeCommand(
    NATIVE_COMMAND_FOR[call.action],
    { sessionID, prompt: { text: plannotatorToolArgs(call).map(quoteArg).join(" ") } },
    deps,
    {
      cwd,
      onReady: (url) => settle({ url }),
      onError: (error) => settle({ error }),
      // The opened text promises an approval message for a gate.
      deliverApproval: gate,
    },
  ).then(
    () => settle({ error: "Plannotator closed before the page opened." }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      settle({ error: message });
      console.error(`[Plannotator] ${NATIVE_COMMAND_FOR[call.action]} (agent shell call) failed: ${message}`);
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<StartOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ pending: true }), call.action === "review" ? READY_WAIT_MS.review : READY_WAIT_MS.other);
    (timer as { unref?: () => void }).unref?.();
  });
  const outcome = await Promise.race([started, waited]);
  if (timer !== undefined) clearTimeout(timer);

  if ("error" in outcome) return shellToolResult(`Plannotator could not open ${subject}: ${outcome.error}`, 1);
  return shellToolResult(plannotatorToolOpenedText(subject, "url" in outcome ? outcome.url : undefined, gate), 0);
}

/**
 * Wrap the shell tool so agent-run `plannotator` commands open through the
 * plugin. Returns whether the host offered a tool editor (the wrap itself runs
 * when the host replays transforms; a host without the shell tool, or one that
 * replays this transform before adding it, keeps the plain CLI).
 */
export async function registerShellTakeover(deps: ShellTakeoverDeps): Promise<boolean> {
  const transform = deps.ctx.tool?.transform;
  if (typeof transform !== "function") return false;
  await transform((editor) => {
    if (typeof editor?.update !== "function") return;
    // Each replay starts from the host's own tool, so this never wraps twice.
    editor.update(SHELL_TOOL_ID, (tool) => {
      const run = tool.execute;
      if (typeof run !== "function") return;
      tool.execute = async (input, context) => {
        const call = shellCallToolInput(input);
        if (!call) return run(input, context);
        return takeOverShellCall(call, input as { workdir?: unknown }, context, deps);
      };
    });
  });
  return true;
}
