import { describe, expect, test } from 'bun:test';
import type { DiagramAnchor } from '@plannotator/core/diagram-anchor';
import { buildDefaultPrompt } from '../hooks/useAIChat';
import {
  diagramAskAIContext,
  diagramIdentityForAskAI,
  MAX_ASK_AI_DIAGRAM_SOURCE_CHARS,
  MAX_ASK_AI_DIAGRAM_SOURCE_LINES,
} from './diagramAskAI';

// Failure to catch: an Ask AI question asked from a diagram comment reaching
// the model (SDK provider, "Ask this session", the agent terminal: all three
// send buildDefaultPrompt's output as the user message) without saying WHICH
// part of WHICH diagram it is about, or flooding the turn with a huge source.

const FENCE_SOURCE = ['flowchart LR', '  U([Reviewer]) --> D{Approve?}', '  D -->|Yes| M[(Merge)]', '  D -->|No| R[Revise]'].join('\n');
/** The fence's opening line is document line 5, so diagram line 2 is document line 7. */
const OFFSET = 5;
const NODE_D: DiagramAnchor = { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] };

describe('diagramAskAIContext', () => {
  test('the question names the family, part kind, id, label and document line, and the question stays last', () => {
    const context = diagramAskAIContext({ kind: 'mermaid', anchor: NODE_D, source: FENCE_SOURCE, sourceLineOffset: OFFSET, sourcePath: '/plans/flow.md' });
    expect(context.kind).toBe('selection');
    expect(context.text).toBe('Approve?');
    const prompt = buildDefaultPrompt({ prompt: 'Should this be a merge queue?', scope: context });
    expect(prompt).toContain('Diagram node Approve? (D), line 7');
    expect(prompt).toContain('Mermaid (flowchart)');
    expect(prompt).toContain('Source: /plans/flow.md');
    // The fence body with its document lines.
    expect(prompt).toContain('document lines 6–9');
    expect(prompt).toContain('D -->|Yes| M[(Merge)]');
    // The Claude Code mod matches its ask turn by first and last line.
    expect(prompt.slice(prompt.lastIndexOf('\n') + 1)).toBe('Should this be a merge queue?');
  });

  test('an edge names both ends; the whole diagram names its line range', () => {
    const edge: DiagramAnchor = { v: 1, family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: 'Yes', sourceLine: [8, 8] };
    const edgeDetail = diagramIdentityForAskAI({ kind: 'mermaid', anchor: edge, source: FENCE_SOURCE, sourceLineOffset: OFFSET });
    expect(edgeDetail).toContain('Diagram edge Yes (D → M), line 8');
    const whole: DiagramAnchor = { v: 1, family: 'graphviz', kind: 'diagram', label: 'digraph G {', sourceLine: [1, 3] };
    const dot = 'digraph G {\n  a -> b\n}';
    const wholeContext = diagramAskAIContext({ kind: 'graphviz', anchor: whole, source: dot, sourceLineOffset: 0 });
    expect(wholeContext.label).toBe('Graphviz diagram');
    expect(wholeContext.detail).toContain('Diagram (graphviz), lines 1–3');
    expect(wholeContext.detail).toContain('````dot\ndigraph G {');
  });

  test('a long diagram sends a bounded excerpt around the part, in document lines', () => {
    const lines = ['flowchart TD'];
    for (let i = 1; i <= 300; i += 1) lines.push(`  N${i}[Step ${i}] --> N${i + 1}`);
    const source = lines.join('\n');
    const anchor: DiagramAnchor = { v: 1, family: 'flowchart', kind: 'node', id: 'N200', label: 'Step 200', sourceLine: [201, 201] };
    const detail = diagramIdentityForAskAI({ kind: 'mermaid', anchor, source, sourceLineOffset: 0 });
    expect(detail).toContain('(excerpt)');
    expect(detail).toContain('N200[Step 200]');
    expect(detail).not.toContain('N1[Step 1]');
    const body = detail.slice(detail.indexOf('````mermaid'));
    expect(body.split('\n').length - 2).toBeLessThanOrEqual(MAX_ASK_AI_DIAGRAM_SOURCE_LINES);
    expect(body.length).toBeLessThanOrEqual(MAX_ASK_AI_DIAGRAM_SOURCE_CHARS + 40);
  });

  test('a source holding a backtick fence cannot close the quoting fence early', () => {
    const source = 'flowchart LR\n  A["````"] --> B';
    const anchor: DiagramAnchor = { v: 1, family: 'flowchart', kind: 'node', id: 'B', label: 'B', sourceLine: [2, 2] };
    const detail = diagramIdentityForAskAI({ kind: 'mermaid', anchor, source, sourceLineOffset: 0 });
    expect(detail).toContain('`````mermaid\n');
  });
});
