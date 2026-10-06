import type { AnnotateOutcome } from "./strict-annotate-result";

export type { AnnotateOutcome } from "./strict-annotate-result";

export interface AnnotateOutputOptions {
  hook: boolean;
  json: boolean;
}

export interface AnnotateApprovalCapabilityOptions extends AnnotateOutputOptions {
  gate: boolean;
}

export interface AnnotateClientLeaseCapabilityOptions extends AnnotateApprovalCapabilityOptions {
  /** True for remote/shared sessions, where a lost tab connection is expected and not abandonment. */
  isRemote: boolean;
}

const APPROVED_PLAINTEXT_MARKER = "The user approved.";

export function supportsAnnotateApprovalNotes(
  options: AnnotateApprovalCapabilityOptions,
): boolean {
  return options.gate && options.json && !options.hook;
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

/**
 * Per-session facts a `--json` record adds. `target` is what the session
 * was of, in full (absolute path, URL, or a bundle's files), so a consumer
 * that delivers the decision as a message (the OpenCode CLI bridge) names it
 * from the CLI's own resolution, never from the words it passed in. Additive:
 * plaintext and `--hook` output never carry it.
 */
export interface AnnotateOutcomeExtra {
  target?: string | readonly string[];
}

export function formatAnnotateOutcome(
  result: AnnotateOutcome,
  options: AnnotateOutputOptions,
  extra: AnnotateOutcomeExtra = {},
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
    const target = extra.target === undefined || extra.target.length === 0
      ? {}
      : { target: typeof extra.target === "string" ? extra.target : [...extra.target] };
    if (result.approved) {
      return JSON.stringify({
        decision: "approved",
        ...(result.feedback ? { feedback: result.feedback } : {}),
        ...count,
        ...target,
      });
    }
    if (result.exit) return JSON.stringify({ decision: "dismissed", ...target });
    return JSON.stringify({
      decision: "annotated",
      feedback: result.feedback || "",
      // Additive, and only on a Done with nothing to send: `feedback` keeps
      // the zero-state sentence, and a consumer that starts agent turns (the
      // OpenCode CLI bridge) skips the turn (#1701).
      ...(result.nothingToSend === true ? { nothingToSend: true } : {}),
      ...count,
      ...target,
    });
  }

  if (result.exit) return null;
  if (result.approved) return APPROVED_PLAINTEXT_MARKER;
  return result.feedback || null;
}

export function createAnnotateOutcomeEmitter(
  options: AnnotateOutputOptions,
): (result: AnnotateOutcome, extra?: AnnotateOutcomeExtra) => void {
  return (result, extra) => {
    const output = formatAnnotateOutcome(result, options, extra);
    if (output !== null) console.log(output);
  };
}
