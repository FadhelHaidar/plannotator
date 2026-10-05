/**
 * Which heading each document's feedback lands under in the submitted export.
 *
 * Failures to catch:
 *  - The open document exported twice: once from the host's live state under
 *    the session heading and again from the linked-doc map, which also carries
 *    the open document (#folder-duplicate, every folder session since 0.27.x).
 *  - The root document's comments vanishing while a linked document is open
 *    (plan review has no source path, so the stashed plan never reached the
 *    export), or landing under the linked heading instead of their own.
 *  - A folder session's documents described as "referenced in the plan".
 *  - The per-section counts disagreeing with what is printed.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation, type ImageAttachment } from '@plannotator/ui/types';
import type { CachedDocState, FeedbackDocuments } from '@plannotator/ui/hooks/useLinkedDoc';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { buildCompleteAnnotateFeedback } from './annotateSubmission';
import { resolveFeedbackSections } from './feedbackDocuments';

const A_PATH = '/repo/docs/a.md';
const B_PATH = '/repo/docs/b.md';
const A_TEXT = '# A\n\nAlpha paragraph to quote.';
const B_TEXT = '# B\n\nBravo paragraph to quote.';
const PLAN_TEXT = '# Plan\n\nPlan paragraph to quote.';

function inline(id: string, markdown: string, quote: string, text: string): Annotation {
  const block = parseMarkdownToBlocks(markdown).find((b) => b.type === 'paragraph')!;
  const start = block.content.indexOf(quote);
  return {
    id,
    blockId: block.id,
    startOffset: start,
    endOffset: start + quote.length,
    type: AnnotationType.COMMENT,
    text,
    originalText: quote,
    createdA: 1,
  };
}

function global(id: string, text: string): Annotation {
  return {
    id,
    blockId: '',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.GLOBAL_COMMENT,
    text,
    originalText: '',
    createdA: 2,
  };
}

function doc(markdown: string, annotations: Annotation[]): CachedDocState {
  return { annotations, globalAttachments: [], markdown };
}

type Source = 'file' | 'folder' | null;

/** What App's getCurrentFeedbackPayload hands the builder. */
function submit(args: {
  annotateSource: Source;
  feedbackDocuments: FeedbackDocuments;
  live: { markdown: string; annotations: Annotation[]; globalAttachments?: ImageAttachment[] };
  externalAnnotations?: Annotation[];
}): string {
  const externals = args.externalAnnotations ?? [];
  const sections = resolveFeedbackSections({
    feedbackDocuments: args.feedbackDocuments,
    live: {
      // App's allAnnotations: the active document's local rows plus externals.
      annotations: [...args.live.annotations, ...externals],
      globalAttachments: args.live.globalAttachments ?? [],
      blocks: parseMarkdownToBlocks(args.live.markdown),
    },
    externalAnnotations: externals,
    sourceConverted: false,
    annotateSource: args.annotateSource,
  });
  return buildCompleteAnnotateFeedback({
    blocks: sections.blocks,
    annotations: sections.annotations,
    globalAttachments: sections.globalAttachments,
    linkedDocuments: sections.linkedDocuments,
    linkedDocumentsHeading: sections.linkedDocumentsHeading,
    editorAnnotations: [],
    codeAnnotations: [],
    title: args.annotateSource === 'folder' ? 'Folder Feedback' : args.annotateSource === 'file' ? 'File Feedback' : 'Plan Feedback',
    subject: args.annotateSource ?? 'plan',
    sourceConverted: sections.sourceConverted,
    directEditsSection: '',
    savedFileChangesSection: '',
  });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Folder sessions: the root is the empty folder placeholder, stashed while a file is open. */
const FOLDER_ROOT = { annotations: [], globalAttachments: [], markdown: '', isConverted: false, renderAs: 'markdown' as const };

describe('folder session feedback export', () => {
  test('comments on the open document are exported once, under its path', () => {
    const anns = [global('g1', 'OPEN-GLOBAL'), inline('i1', A_TEXT, 'Alpha paragraph', 'OPEN-INLINE')];
    const out = submit({
      annotateSource: 'folder',
      feedbackDocuments: { root: FOLDER_ROOT, documents: new Map([[A_PATH, doc(A_TEXT, anns)]]) },
      live: { markdown: A_TEXT, annotations: anns },
    });

    expect(count(out, 'OPEN-GLOBAL')).toBe(1);
    expect(count(out, 'OPEN-INLINE')).toBe(1);
    expect(count(out, `## ${A_PATH}`)).toBe(1);
    expect(out).toContain('have 2 pieces of feedback');
    // Nothing was said about the folder as a whole.
    expect(out).not.toContain('# Folder Feedback');
    // A folder's files are not documents a plan referenced.
    expect(out).not.toContain('referenced in the plan');
    expect(out).toContain('# Folder Document Feedback');
  });

  test('comments on another document only are exported once, under that path', () => {
    const bAnns = [inline('i2', B_TEXT, 'Bravo paragraph', 'OTHER-INLINE')];
    const out = submit({
      annotateSource: 'folder',
      feedbackDocuments: {
        root: FOLDER_ROOT,
        documents: new Map([[B_PATH, doc(B_TEXT, bAnns)], [A_PATH, doc(A_TEXT, [])]]),
      },
      live: { markdown: A_TEXT, annotations: [] },
    });

    expect(count(out, 'OTHER-INLINE')).toBe(1);
    expect(count(out, `## ${B_PATH}`)).toBe(1);
    expect(out).not.toContain(`## ${A_PATH}`);
    expect(out).toContain('have 1 piece of feedback');
  });

  test('comments on both documents each appear once, under their own path', () => {
    const aAnns = [global('g1', 'OPEN-GLOBAL'), inline('i1', A_TEXT, 'Alpha paragraph', 'OPEN-INLINE')];
    const bAnns = [inline('i2', B_TEXT, 'Bravo paragraph', 'OTHER-INLINE')];
    const out = submit({
      annotateSource: 'folder',
      feedbackDocuments: {
        root: FOLDER_ROOT,
        documents: new Map([[B_PATH, doc(B_TEXT, bAnns)], [A_PATH, doc(A_TEXT, aAnns)]]),
      },
      live: { markdown: A_TEXT, annotations: aAnns },
    });

    for (const text of ['OPEN-GLOBAL', 'OPEN-INLINE', 'OTHER-INLINE']) expect(count(out, text)).toBe(1);
    const aSection = out.slice(out.indexOf(`## ${A_PATH}`));
    const bSection = out.slice(out.indexOf(`## ${B_PATH}`), out.indexOf(`## ${A_PATH}`));
    expect(bSection).toContain('OTHER-INLINE');
    expect(bSection).toContain('have 1 piece of feedback');
    expect(aSection).toContain('OPEN-INLINE');
    expect(aSection).toContain('have 2 pieces of feedback');
  });
});

describe('plain session with a linked document', () => {
  const planAnn = inline('p1', PLAN_TEXT, 'Plan paragraph', 'PLAN-COMMENT');
  const linkedAnn = inline('l1', B_TEXT, 'Bravo paragraph', 'LINKED-COMMENT');

  test('submitted from the plan: plan under its heading, linked doc under the linked heading (unchanged)', () => {
    const out = submit({
      annotateSource: null,
      feedbackDocuments: { root: null, documents: new Map([[B_PATH, doc(B_TEXT, [linkedAnn])]]) },
      live: { markdown: PLAN_TEXT, annotations: [planAnn] },
    });

    expect(out.indexOf('# Plan Feedback')).toBeLessThan(out.indexOf('PLAN-COMMENT'));
    expect(out.indexOf('# Linked Document Feedback')).toBeLessThan(out.indexOf('LINKED-COMMENT'));
    expect(out.indexOf('PLAN-COMMENT')).toBeLessThan(out.indexOf('# Linked Document Feedback'));
    expect(count(out, 'PLAN-COMMENT')).toBe(1);
    expect(count(out, 'LINKED-COMMENT')).toBe(1);
    expect(out).toContain('documents referenced in the plan');
  });

  test('submitted while the linked doc is open: same headings, each comment once', () => {
    const out = submit({
      annotateSource: null,
      feedbackDocuments: {
        root: { annotations: [planAnn], globalAttachments: [], markdown: PLAN_TEXT, isConverted: false, renderAs: 'markdown' },
        documents: new Map([[B_PATH, doc(B_TEXT, [linkedAnn])]]),
      },
      live: { markdown: B_TEXT, annotations: [linkedAnn] },
    });

    expect(count(out, 'PLAN-COMMENT')).toBe(1);
    expect(count(out, 'LINKED-COMMENT')).toBe(1);
    expect(out.indexOf('# Plan Feedback')).toBeLessThan(out.indexOf('PLAN-COMMENT'));
    expect(out.indexOf('PLAN-COMMENT')).toBeLessThan(out.indexOf('# Linked Document Feedback'));
    expect(out.indexOf(`## ${B_PATH}`)).toBeLessThan(out.indexOf('LINKED-COMMENT'));
    // The plan comment keeps the plan's line number, not the linked doc's.
    expect(out).toContain('(line 3) Feedback on: "Plan paragraph"');
  });

  test('external annotations ride the session heading whichever document is open', () => {
    const external: Annotation = { ...global('x1', 'EXTERNAL-NOTE'), source: 'eslint' };
    const out = submit({
      annotateSource: 'file',
      feedbackDocuments: {
        root: { annotations: [planAnn], globalAttachments: [], markdown: PLAN_TEXT, isConverted: false, renderAs: 'markdown' },
        documents: new Map([[B_PATH, doc(B_TEXT, [linkedAnn])]]),
      },
      live: { markdown: B_TEXT, annotations: [linkedAnn] },
      externalAnnotations: [external],
    });

    expect(count(out, 'EXTERNAL-NOTE')).toBe(1);
    expect(out.indexOf('EXTERNAL-NOTE')).toBeLessThan(out.indexOf('# Linked Document Feedback'));
    expect(out).toContain('have 2 pieces of feedback');
  });
});
