/**
 * Per-document draft copies (annotate-draft.ts on the server): the pure half.
 *
 * A local-file or folder annotate session saves each document it holds
 * comments on (other than its own root, which rides the session draft) under
 * that document's path, and merges a document's saved comments in the first
 * time the document is opened. These helpers decide what to send and what to
 * merge; useDocumentDrafts does the I/O.
 */

import type { Annotation, ImageAttachment } from '@plannotator/ui/types';

export interface DocumentDraftState {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
}

export interface DocumentDraftWrite {
  path: string;
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
}

const serialize = (state: DocumentDraftState): string =>
  JSON.stringify([state.annotations, state.globalAttachments]);

const EMPTY = serialize({ annotations: [], globalAttachments: [] });

/**
 * The writes that bring the server's copies in line with the session.
 *
 *  - Only documents whose saved copy has been read (`loaded`) are written:
 *    writing one before its copy was merged in would replace comments from an
 *    earlier session with this session's subset.
 *  - A document is written only when it differs from what was last sent.
 *  - A document that was sent with content and has none now (its comments
 *    were deleted, in place or from the cross-file panel) is sent empty, which
 *    clears its copy. A document never sent with content is never sent empty.
 *  - `rootPath` (a single-file session's own file) is skipped: the session
 *    draft carries it.
 */
export function planDocumentDraftWrites(input: {
  documents: ReadonlyMap<string, DocumentDraftState>;
  lastSent: ReadonlyMap<string, string>;
  loaded: ReadonlySet<string>;
  rootPath?: string | null;
}): { writes: DocumentDraftWrite[]; sent: Map<string, string> } {
  const writes: DocumentDraftWrite[] = [];
  const sent = new Map(input.lastSent);
  const seen = new Set<string>();
  for (const [path, state] of input.documents) {
    if (input.rootPath && path === input.rootPath) continue;
    if (!input.loaded.has(path)) continue;
    seen.add(path);
    const next = serialize(state);
    const previous = input.lastSent.get(path);
    if (previous === next) continue;
    if (previous === undefined && next === EMPTY) continue;
    writes.push({ path, annotations: state.annotations, globalAttachments: state.globalAttachments });
    sent.set(path, next);
  }
  for (const [path, previous] of input.lastSent) {
    if (seen.has(path) || previous === EMPTY) continue;
    writes.push({ path, annotations: [], globalAttachments: [] });
    sent.set(path, EMPTY);
  }
  return { writes, sent };
}

/**
 * What a document's saved copy adds to the comments the session already holds
 * for it: entries whose id the session does not hold (comments), and
 * attachments whose path it does not hold.
 */
export function documentDraftAdditions(
  held: DocumentDraftState,
  saved: { annotations: unknown; globalAttachments: unknown },
): DocumentDraftState {
  const heldIds = new Set(held.annotations.map((a) => a.id));
  const heldPaths = new Set(held.globalAttachments.map((g) => g.path));
  const annotations = (Array.isArray(saved.annotations) ? saved.annotations : []).filter(
    (a): a is Annotation =>
      !!a && typeof a === 'object' && typeof (a as Annotation).id === 'string' && !heldIds.has((a as Annotation).id),
  );
  const globalAttachments = (Array.isArray(saved.globalAttachments) ? saved.globalAttachments : []).filter(
    (g): g is ImageAttachment =>
      !!g && typeof g === 'object' && typeof (g as ImageAttachment).path === 'string' && !heldPaths.has((g as ImageAttachment).path),
  );
  return { annotations, globalAttachments };
}
