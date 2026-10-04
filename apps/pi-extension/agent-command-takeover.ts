/**
 * An agent that runs `plannotator annotate|review|last` through its `bash`
 * tool gets the same session the slash commands open: in-process, non-blocking,
 * the decision delivered later as a message, and Ask AI answered by this
 * session. Without this the CLI would run as a child of the bash tool, block
 * the turn until the reviewer decided, and offer Ask AI a separate AI.
 *
 * Which commands are taken over is decided once, for every host, by the
 * shared `plannotatorCommandToToolInput` (simple commands with flags the
 * `plannotator` tool represents; strict gates, pipelines and unusual flags run
 * unchanged).
 *
 * Pi lets a `tool_call` handler block a call with a reason, nothing more: the
 * reason becomes the call's (error-flagged) result and the command never runs.
 * So the answer is the tool's "opened" text as that reason, with `terminate`
 * so the agent ends its turn and waits for the decision.
 */

import {
	plannotatorCommandToToolInput,
	plannotatorToolOpenedText,
	plannotatorToolSubject,
	type PlannotatorToolInput,
} from "./generated/plannotator-tool.ts";

/** What an open path reports: the session URL, or the error it notified. */
export type AgentOpenOutcome = { ok: true; url: string } | { ok: false; error: string };

/** Opens the session for a taken-over call; null when this session cannot open it (the command then runs as written). */
export type AgentCommandOpener = (input: PlannotatorToolInput) => Promise<AgentOpenOutcome | null>;

export interface BashTakeOverAnswer {
	block: true;
	reason: string;
	terminate?: true;
}

/**
 * The `tool_call` answer for a bash `command`: undefined to let it run, or a
 * block whose reason is the opened text (`terminate`: the agent ends its turn
 * and waits) or the open error (the agent continues and can correct it).
 */
export async function takeOverBashCommand(
	command: unknown,
	open: AgentCommandOpener,
): Promise<BashTakeOverAnswer | undefined> {
	if (typeof command !== "string") return undefined;
	const input = plannotatorCommandToToolInput(command);
	if (!input) return undefined;
	const outcome = await open(input);
	if (!outcome) return undefined;
	const subject = plannotatorToolSubject(input);
	if (!outcome.ok) return { block: true, reason: `Plannotator could not open ${subject}: ${outcome.error}` };
	return {
		block: true,
		reason: plannotatorToolOpenedText(subject, outcome.url, input.gate === true),
		terminate: true,
	};
}
