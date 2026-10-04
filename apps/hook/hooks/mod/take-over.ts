/**
 * Claude running the `plannotator` CLI through Bash, answered by the mod.
 *
 * The skill and the tool steer Claude to the `plannotator` tool, but a model
 * that reaches for `plannotator annotate x.md --gate --json` in Bash would
 * otherwise block the session on the CLI and give Ask AI a separate AI. When
 * the command is one the tool can represent (`plannotatorCommandToToolInput`
 * in tool.ts decides, host-neutral), the `tool.call` hook answers the Bash call
 * with the tool's own launch and result text; the command never runs. Anything
 * else (strict gates, pipelines, unknown flags) runs as written.
 */

import { plannotatorCommandToToolInput, type PlannotatorToolInput } from './tool'

/** Claude Code's shell tool. */
export const SHELL_TOOL = 'Bash'

/** `last` reads the main session's transcript, so a subagent would annotate a message it never wrote. */
export const SUBAGENT_LAST_DENY =
  'Invalid plannotator call: action "last" annotates the main session\'s last message and is not available to a subagent.'

export type ShellTakeOver = { input: PlannotatorToolInput } | { deny: string }

/** What to do with a Bash call's command: null runs it as written. */
export function shellTakeOver(command: unknown, fromSubagent: boolean): ShellTakeOver | null {
  if (typeof command !== 'string') return null
  const input = plannotatorCommandToToolInput(command)
  if (!input) return null
  if (fromSubagent && input.action === 'last') return { deny: SUBAGENT_LAST_DENY }
  return { input }
}

/** The Bash tool's result record, carrying the tool's text as the command's output. */
export interface ShellResult {
  stdout: string
  stderr: string
  interrupted: boolean
}

/** Open through the tool's launch; the tool's text becomes the Bash result, its error a deny. */
export async function answerShellCall(
  mod: { runTool(input: unknown): Promise<{ text: string } | { deny: string }> },
  input: PlannotatorToolInput,
): Promise<{ result: ShellResult } | { deny: string }> {
  const answer = await mod.runTool(input)
  return 'deny' in answer ? { deny: answer.deny } : { result: { stdout: answer.text, stderr: '', interrupted: false } }
}
