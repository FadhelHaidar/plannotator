/**
 * Copy for a review the agent closed (`POST /api/host/close`,
 * packages/shared/host-control.ts). The tab learns it from the
 * `session-closed` event on the external-annotation stream.
 */

export const AGENT_CLOSED_TITLE = 'Closed by the Agent';

export function agentClosedSubtitle(unsentAnnotations: number): string {
  if (unsentAnnotations <= 0) return 'The agent closed this review.';
  const comments = unsentAnnotations === 1 ? 'Your comment is' : `Your ${unsentAnnotations} comments are`;
  return `The agent closed this review. ${comments} saved and come${unsentAnnotations === 1 ? 's' : ''} back when it is reopened.`;
}
