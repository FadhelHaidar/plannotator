import { describe, expect, test } from 'bun:test';
import type { Annotation } from '@plannotator/ui/types';
import { documentDraftAdditions, planDocumentDraftWrites, type DocumentDraftState } from './documentDrafts';

const ann = (id: string) => ({ id, text: id }) as unknown as Annotation;
const state = (...ids: string[]): DocumentDraftState => ({ annotations: ids.map(ann), globalAttachments: [] });

describe('planDocumentDraftWrites', () => {
  test('never writes a document whose saved copy has not been read yet', () => {
    // Writing it would replace an earlier session's comments with this subset.
    const { writes } = planDocumentDraftWrites({
      documents: new Map([['/d/a.md', state('mine')]]),
      lastSent: new Map(),
      loaded: new Set(),
    });
    expect(writes).toEqual([]);
  });

  test('writes changed documents once, and skips the session root', () => {
    const documents = new Map([['/d/a.md', state('c1')], ['/d/root.md', state('r')]]);
    const first = planDocumentDraftWrites({
      documents,
      lastSent: new Map(),
      loaded: new Set(['/d/a.md', '/d/root.md']),
      rootPath: '/d/root.md',
    });
    expect(first.writes.map((w) => w.path)).toEqual(['/d/a.md']);
    const again = planDocumentDraftWrites({ documents, lastSent: first.sent, loaded: new Set(['/d/a.md']), rootPath: '/d/root.md' });
    expect(again.writes).toEqual([]);
  });

  test('clears a document whose comments were all deleted, but never sends an untouched one empty', () => {
    const loaded = new Set(['/d/a.md', '/d/b.md']);
    const sent = planDocumentDraftWrites({ documents: new Map([['/d/a.md', state('c1')]]), lastSent: new Map(), loaded }).sent;
    const { writes } = planDocumentDraftWrites({
      documents: new Map([['/d/a.md', state()], ['/d/b.md', state()]]),
      lastSent: sent,
      loaded,
    });
    expect(writes).toEqual([{ path: '/d/a.md', annotations: [], globalAttachments: [] }]);
  });
});

describe('documentDraftAdditions', () => {
  test('adds only the saved comments the session does not already hold', () => {
    const additions = documentDraftAdditions(state('kept'), {
      annotations: [ann('kept'), ann('new'), { notAnAnnotation: true }],
      globalAttachments: [],
    });
    expect(additions.annotations.map((a) => a.id)).toEqual(['new']);
  });
});
