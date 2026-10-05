/**
 * Copy for a review the agent closed (`POST /api/host/close`,
 * packages/shared/host-control.ts). The tab learns it from the
 * `session-closed` event on the external-annotation stream.
 *
 * The close keeps the draft, but what brings it back is each surface's own
 * draft key: annotate drafts are keyed by the document's content, code review
 * drafts by the patch (or the PR). So the copy promises a restore only for the
 * same unchanged document or the same changes.
 */

export const AGENT_CLOSED_TITLE = 'Closed by the Agent';

/** `document`: plan editor surfaces (annotate, annotate-last). `changes`: code review. */
export type AgentClosedSurface = 'document' | 'changes';

export function agentClosedSubtitle(unsentAnnotations: number, surface: AgentClosedSurface = 'document'): string {
  if (unsentAnnotations <= 0) return 'The agent closed this review.';
  const comments = unsentAnnotations === 1 ? 'Your comment is' : `Your ${unsentAnnotations} comments are`;
  const restore = surface === 'changes'
    ? 'Reopening a review of the same changes brings it back.'
    : 'Reopening the same document, unchanged, brings it back.';
  return `The agent closed this review. ${comments} saved as a draft. ${restore}`;
}
