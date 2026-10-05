import type { Annotation } from '@plannotator/ui/types';
import type { RestoredAnchor } from '@plannotator/ui/hooks/useAnnotationHighlighter';

/**
 * Write a restore pass's `moved` anchors back onto the annotations, so the
 * export's line labels (read from `blockId`) name where each comment's text is
 * now rather than where it was when the comment was made.
 *
 * - A comment whose text landed in another block takes that block's id and
 *   offsets; its stored positions are dropped when they did not lead to the
 *   text (the next restore then searches by text, as this one did).
 * - A comment whose text is gone gets `blockId: ''` — the same "no longer in
 *   the document" value Edit Mode's remap uses — so it exports with no line
 *   label instead of a confident wrong one, and drops its stale positions.
 *
 * Checkbox overrides are keyed by their block and are never touched. Returns
 * the SAME array when nothing changes, so an unchanged document causes no
 * state update (and no draft save).
 */
export function applyRestoredAnchors(
  annotations: Annotation[],
  moved: readonly RestoredAnchor[] | undefined,
): Annotation[] {
  if (!moved || moved.length === 0) return annotations;
  const byId = new Map(moved.map((entry) => [entry.id, entry]));
  let changed = false;
  const next = annotations.map((ann) => {
    const entry = byId.get(ann.id);
    if (!entry || ann.id.startsWith('ann-checkbox-')) return ann;
    const dropPositions = entry.positionsStale && (ann.startMeta !== undefined || ann.endMeta !== undefined);
    const offsetsChange = entry.blockId !== '' && entry.startOffset !== undefined
      && entry.startOffset !== ann.startOffset;
    if (entry.blockId === ann.blockId && !dropPositions && !offsetsChange) return ann;
    changed = true;
    const updated: Annotation = { ...ann, blockId: entry.blockId };
    if (offsetsChange && entry.startOffset !== undefined) {
      updated.startOffset = entry.startOffset;
      updated.endOffset = entry.startOffset + ann.originalText.length;
    }
    if (dropPositions) {
      delete updated.startMeta;
      delete updated.endMeta;
    }
    return updated;
  });
  return changed ? next : annotations;
}
