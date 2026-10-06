import type { Origin } from "@plannotator/shared/agents";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { getAnnotateApprovedWithNotesPrompt } from "@plannotator/shared/prompts";
import type { AnnotateOutcome } from "./strict-annotate-result";

export type { AnnotateOutcome } from "./strict-annotate-result";

export interface AnnotateOutputOptions {
  hook: boolean;
  json: boolean;
}

export interface AnnotateApprovalCapabilityOptions {
  gate: boolean;
  hook: boolean;
}

export interface AnnotateClientLeaseCapabilityOptions extends AnnotateOutputOptions {
  gate: boolean;
  /** True for remote/shared sessions, where a lost tab connection is expected and not abandonment. */
  isRemote: boolean;
}

/**
 * What a plaintext approval WITH notes is framed with: the configured
 * approved-with-notes prompt, the same framing the result file, OpenCode and Pi
 * deliver. `context` names the file/folder/URL (`File: <path>`); annotate-last
 * has none.
 */
export interface AnnotateApprovalNotesContext {
  runtime?: Origin;
  context?: string;
  config?: PlannotatorConfig;
}

const APPROVED_PLAINTEXT_MARKER = "The user approved.";

/**
 * Whether an approval can carry a note to the agent, which is what shows
 * "Approve with a note…" / "Approve with notes" in the annotate header. Every
 * gated output delivers it (JSON as `feedback`, plaintext as the
 * approved-with-notes message, and the Claude Code mod's result file, which a
 * plaintext launch also writes) except `--hook`, whose protocol has no message
 * on approval.
 */
export function supportsAnnotateApprovalNotes(
  options: AnnotateApprovalCapabilityOptions,
): boolean {
  return options.gate && !options.hook;
}

/**
 * Local direct structured annotate gates (`--gate --json`, not `--hook`, not
 * a remote/shared session) are the only transport where a tab's abandonment
 * can be safely resolved automatically — the caller is already blocked on a
 * structured decision and no other protocol (hook JSON, plaintext) depends on
 * the exact timing of the response.
 */
export function supportsAnnotateClientLease(
  options: AnnotateClientLeaseCapabilityOptions,
): boolean {
  return options.gate && options.json && !options.hook && !options.isRemote;
}

export function formatAnnotateOutcome(
  result: AnnotateOutcome,
  options: AnnotateOutputOptions,
  notes?: AnnotateApprovalNotesContext,
): string | null {
  if (options.hook) {
    if (result.approved || result.exit) return null;
    return result.feedback
      ? JSON.stringify({ decision: "block", reason: result.feedback })
      : null;
  }

  if (options.json) {
    // Additive: how many annotations the decision carried, so a host can name
    // the count in the message it delivers (the OpenCode bridge's decision
    // heading). Absent when the decision carried no annotations list.
    const count = Array.isArray(result.annotations) ? { annotationCount: result.annotations.length } : {};
    if (result.approved) {
      return JSON.stringify({
        decision: "approved",
        ...(result.feedback ? { feedback: result.feedback } : {}),
        ...count,
      });
    }
    if (result.exit) return JSON.stringify({ decision: "dismissed" });
    return JSON.stringify({
      decision: "annotated",
      feedback: result.feedback || "",
      // Additive, and only on a Done with nothing to send: `feedback` keeps
      // the zero-state sentence, and a consumer that starts agent turns (the
      // OpenCode CLI bridge) skips the turn (#1701).
      ...(result.nothingToSend === true ? { nothingToSend: true } : {}),
      ...count,
    });
  }

  if (result.exit) return null;
  if (result.approved) {
    // A bare approval keeps the legacy marker byte for byte; only an approval
    // that carries a note (gate sessions, "Approve with a note…") is framed.
    const feedback = result.feedback?.trim() ? result.feedback : "";
    if (!feedback) return APPROVED_PLAINTEXT_MARKER;
    return getAnnotateApprovedWithNotesPrompt(notes?.runtime, notes?.config, {
      context: notes?.context,
      feedback,
    });
  }
  return result.feedback || null;
}

export function createAnnotateOutcomeEmitter(
  options: AnnotateOutputOptions,
): (result: AnnotateOutcome, notes?: AnnotateApprovalNotesContext) => void {
  return (result, notes) => {
    const output = formatAnnotateOutcome(result, options, notes);
    if (output !== null) console.log(output);
  };
}
