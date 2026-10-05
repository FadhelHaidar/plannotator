/**
 * Which annotations go under which heading in a submitted feedback export.
 *
 * The export has a primary section for the session's own document (the plan,
 * the annotated file, or the folder) and a section listing every OTHER
 * document by path. The host's live state (`annotations`, `blocks`) is the
 * ACTIVE document, which is the root only while no linked/folder document is
 * open. Exporting the live state as the primary section AND the linked-doc map
 * (which also carries the active document) printed the open document twice.
 * This module decides the split once, for every export path.
 */
import type { Annotation, Block, ImageAttachment } from '@plannotator/ui/types';
import type { FeedbackDocuments } from '@plannotator/ui/hooks/useLinkedDoc';
import {
  diagramDocumentBlocks,
  parseMarkdownToBlocks,
  FOLDER_DOC_EXPORT_HEADING,
  LINKED_DOC_EXPORT_HEADING,
  type LinkedDocAnnotationEntry,
  type LinkedDocExportHeading,
} from '@plannotator/ui/utils/parser';
import { diagramRenderKindForPath, isDiagramRenderKind, shouldStripFrontmatter } from '@plannotator/shared/annotatable';

/**
 * Blocks for a document identified by path: a diagram source (.mmd/.dot) is
 * ONE diagram block over its raw text, everything else is the markdown parse
 * with that path's frontmatter rule.
 */
export const blocksForDocument = (filepath: string, text: string): Block[] => {
  const kind = diagramRenderKindForPath(filepath);
  return kind !== null
    ? diagramDocumentBlocks(text, kind)
    : parseMarkdownToBlocks(text, { frontmatter: shouldStripFrontmatter(filepath) });
};

/**
 * Merge local annotations with SSE-delivered external ones, dropping
 * draft-restored copies of externals that SSE re-delivered (same source,
 * type and quote). The SSE version wins.
 */
export function mergeExternalAnnotations(local: Annotation[], external: Annotation[]): Annotation[] {
  if (external.length === 0) return local;
  const kept = local.filter((a) => {
    if (!a.source) return true;
    return !external.some((ext) =>
      ext.source === a.source &&
      ext.type === a.type &&
      ext.originalText === a.originalText
    );
  });
  return [...kept, ...external];
}

export interface FeedbackSectionsInput {
  /** The split from useLinkedDoc. */
  feedbackDocuments: FeedbackDocuments;
  /** Live state of the ACTIVE document; `annotations` already carries externals. */
  live: { annotations: Annotation[]; globalAttachments: ImageAttachment[]; blocks: Block[] };
  /** SSE externals. They belong to the session, not to one document, so they
   *  ride the primary section whichever document is open. */
  externalAnnotations: Annotation[];
  /** The root document's path (annotate file sessions); drives its parse. */
  sourceFilePath?: string;
  sourceConverted: boolean;
  annotateSource: 'file' | 'message' | 'folder' | null;
}

export interface FeedbackSections {
  /** The primary section: the root document. */
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  blocks: Block[];
  sourceConverted: boolean;
  /** Every other document, once, by path, with blocks for line labels. */
  linkedDocuments: Map<string, LinkedDocAnnotationEntry>;
  linkedDocumentsHeading: LinkedDocExportHeading;
}

export function resolveFeedbackSections(input: FeedbackSectionsInput): FeedbackSections {
  const { root, documents } = input.feedbackDocuments;

  let annotations = input.live.annotations;
  let globalAttachments = input.live.globalAttachments;
  let blocks = input.live.blocks;
  if (root) {
    // A linked document is open, so the live state is THAT document (it is in
    // `documents`); the primary section is the stashed root.
    annotations = mergeExternalAnnotations(root.annotations, input.externalAnnotations);
    globalAttachments = root.globalAttachments;
    const markdown = root.markdown ?? '';
    blocks = isDiagramRenderKind(root.renderAs)
      ? diagramDocumentBlocks(markdown, root.renderAs)
      : parseMarkdownToBlocks(markdown, { frontmatter: shouldStripFrontmatter(input.sourceFilePath) });
  }

  const linkedDocuments = new Map<string, LinkedDocAnnotationEntry>();
  for (const [filepath, entry] of documents) {
    linkedDocuments.set(filepath, entry.markdown
      ? { ...entry, blocks: blocksForDocument(filepath, entry.markdown) }
      : entry);
  }

  return {
    annotations,
    globalAttachments,
    blocks,
    sourceConverted: input.sourceConverted,
    linkedDocuments,
    linkedDocumentsHeading: input.annotateSource === 'folder'
      ? FOLDER_DOC_EXPORT_HEADING
      : LINKED_DOC_EXPORT_HEADING,
  };
}
