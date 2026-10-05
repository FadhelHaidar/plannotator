import { describe, expect, test } from 'bun:test'
import {
  isOlderCliBundleRefusal,
  normalizePlannotatorSessionId,
  plannotatorBundleSubject,
  parsePlannotatorToolInput,
  plannotatorDecisionHeading,
  plannotatorToolArgs,
  plannotatorToolCloseText,
  plannotatorToolListText,
  plannotatorToolOpenedText,
  PLANNOTATOR_TOOL_INPUT_SCHEMA,
} from './plannotator-tool'

function args(value: unknown): string[] {
  const parsed = parsePlannotatorToolInput(value)
  if (!parsed.ok) throw new Error(parsed.error)
  return plannotatorToolArgs(parsed.input)
}

function error(value: unknown): string {
  const parsed = parsePlannotatorToolInput(value)
  if (parsed.ok) throw new Error(`accepted ${JSON.stringify(value)}`)
  return parsed.error
}

describe('plannotator tool: arguments', () => {
  // The failure: a call maps to argv the slash command would not produce
  // (a lost flag, a target split in two, a flag order the CLI misreads).
  test('maps each action to the slash command words', () => {
    expect(args({ action: 'annotate', target: 'docs/my notes.md' })).toEqual(['docs/my notes.md'])
    expect(args({ action: 'annotate', target: 'spec.md', gate: true, options: { markdown: true } })).toEqual(['spec.md', '--gate', '--markdown'])
    expect(args({ action: 'review' })).toEqual([])
    expect(args({ action: 'review', target: 'https://github.com/o/r/pull/7' })).toEqual(['https://github.com/o/r/pull/7'])
    expect(args({ action: 'review', target: '../wt', options: { base: 'feature/part-1' } })).toEqual(['--base', 'feature/part-1', '../wt'])
    expect(args({ action: 'last' })).toEqual([])
  })

  test('false defaults a model fills in are ignored, not errors', () => {
    expect(args({ action: 'review', gate: false, options: { markdown: false } })).toEqual([])
    expect(args({ action: 'last', gate: false, options: {} })).toEqual([])
  })
})

describe('plannotator tool: strict validation', () => {
  test('refuses what the CLI would misread or the action does not take', () => {
    expect(error(null)).toContain('object')
    expect(error({ action: 'plan' })).toContain('action')
    expect(error({ action: 'annotate' })).toContain('needs a target')
    expect(error({ action: 'annotate', target: '--hook' })).toContain('"-"')
    expect(error({ action: 'annotate', target: 'a.md\nb.md' })).toContain('control')
    expect(error({ action: 'annotate', target: '  ' })).toContain('empty')
    expect(error({ action: 'last', target: 'x.md' })).toContain('no target')
    expect(error({ action: 'review', gate: true })).toContain('gate')
    expect(error({ action: 'annotate', target: 'a.md', options: { base: 'main' } })).toContain('options.base')
    expect(error({ action: 'review', options: { base: '-c' } })).toContain('"-"')
    expect(error({ action: 'review', options: { base: 'a b' } })).toContain('spaces')
    expect(error({ action: 'review', options: { markdown: true } })).toContain('options.markdown')
    expect(error({ action: 'review', json: true })).toContain('unknown field')
    expect(error({ action: 'review', options: { diffType: 'staged' } })).toContain('unknown option')
    expect(error({ action: 'annotate', target: 'a.md', gate: 'yes' })).toContain('gate')
  })

  test('the schema names exactly the fields the validator accepts', () => {
    expect(Object.keys(PLANNOTATOR_TOOL_INPUT_SCHEMA.properties).sort()).toEqual(['action', 'comment', 'gate', 'options', 'resolve', 'session', 'target', 'text'])
    expect([...PLANNOTATOR_TOOL_INPUT_SCHEMA.properties.action.enum].sort()).toEqual(['annotate', 'close', 'last', 'list', 'reply', 'review'])
    expect(Object.keys(PLANNOTATOR_TOOL_INPUT_SCHEMA.properties.options.properties).sort()).toEqual(['base', 'markdown'])
  })
})

describe('plannotator tool v2: several targets', () => {
  // The failure: a list is re-split, reordered, or a list where it means
  // nothing (review) is silently flattened into one argument.
  test('annotate keeps the list in order, one argument per file, duplicates dropped', () => {
    expect(args({ action: 'annotate', target: ['spec.md', 'mock.html', 'notes.md'] })).toEqual(['spec.md', 'mock.html', 'notes.md'])
    expect(args({ action: 'annotate', target: ['b.md', 'a.md', 'b.md'], gate: true })).toEqual(['b.md', 'a.md', '--gate'])
  })

  // The failure: a bare list entry ("README") reaches the CLI as a word, the
  // CLI reads the list as prose, and a missing file silently narrows the
  // review to the files that exist.
  test('a bare list entry is passed as a path, so a missing one fails instead of being read as prose', () => {
    expect(args({ action: 'annotate', target: ['README', 'docs/a.md'] })).toEqual(['./README', 'docs/a.md'])
    expect(args({ action: 'annotate', target: 'README' })).toEqual(['README'])
  })

  test('a one-file list is the plain single-target call', () => {
    const parsed = parsePlannotatorToolInput({ action: 'annotate', target: ['notes.md', ' notes.md '] })
    expect(parsed.ok && parsed.input.target).toBe('notes.md')
  })

  test('refuses an empty list, a bad entry, and a list outside annotate', () => {
    expect(error({ action: 'annotate', target: [] })).toContain('empty list')
    expect(error({ action: 'annotate', target: ['a.md', '--hook'] })).toContain('target[1]')
    expect(error({ action: 'annotate', target: ['a.md', 3] })).toContain('target[1]')
    expect(error({ action: 'review', target: ['a', 'b'] })).toContain('annotate')
  })
})

describe('plannotator tool: reviews of several files', () => {
  // The failure: a host cannot tell an older CLI's refusal of several paths
  // from the current CLI's own ambiguity error (a URL among the files), and
  // either tells the agent to update when it should fix its call, or the
  // reverse.
  test('an older CLI refusal is the ambiguity error without the bundle hint', () => {
    const older = 'Ambiguous annotate arguments: 2 of them each resolve to an existing target.\n  a.md -> /r/a.md\n  b.md -> /r/b.md\nRe-run with exactly one target: plannotator annotate <...>'
    expect(isOlderCliBundleRefusal(older)).toBe(true)
    expect(isOlderCliBundleRefusal(`${older}\nTo review several files together, pass only their paths: plannotator annotate a.md b.html`)).toBe(false)
    expect(isOlderCliBundleRefusal('File not found: a.md')).toBe(false)
  })

  test('a bundle is named by its count and first file names', () => {
    expect(plannotatorBundleSubject(['/r/spec.md', '/r/mock.html'])).toBe('2 files: spec.md, mock.html')
    expect(plannotatorBundleSubject(['a.md', 'docs/b.md', 'c\\d.md', 'e.md', 'f.md'])).toBe('5 files: a.md, b.md, d.md +2 more')
  })
})

describe('plannotator tool v2: list, close, reply', () => {
  test('list and close take no open fields; close needs a session id or "all"', () => {
    expect(args({ action: 'list' })).toEqual([])
    expect(error({ action: 'list', target: 'x.md' })).toContain('no target')
    expect(error({ action: 'list', session: 'pn-3f2a9c' })).toContain('session')
    expect(error({ action: 'close' })).toContain('needs a session')
    expect(error({ action: 'close', session: 'notes.md' })).toContain('pn-3f2a9c')
    expect(error({ action: 'close', session: 'pn-3f2a9c', gate: true })).toContain('gate')
    const all = parsePlannotatorToolInput({ action: 'close', session: 'ALL' })
    expect(all.ok && all.input.session).toBe('all')
    const one = parsePlannotatorToolInput({ action: 'close', session: ' PN-3F2A9C ' })
    expect(one.ok && one.input.session).toBe('pn-3f2a9c')
  })

  test('reply is validated even though no host answers it yet', () => {
    const ok = parsePlannotatorToolInput({ action: 'reply', session: 'pn-3f2a9c', comment: 'c3', text: 'Done.', resolve: true })
    expect(ok.ok && ok.input).toEqual({ action: 'reply', session: 'pn-3f2a9c', comment: 'c3', text: 'Done.', resolve: true })
    expect(error({ action: 'reply', session: 'all', comment: 'c3', text: 'x' })).toContain('session id')
    expect(error({ action: 'reply', session: 'pn-3f2a9c', comment: 'ann-1', text: 'x' })).toContain('comment')
    expect(error({ action: 'reply', session: 'pn-3f2a9c', comment: 'c3', text: ' ' })).toContain('text')
    expect(error({ action: 'annotate', target: 'a.md', text: 'x' })).toContain('"reply" only')
    // A false default a model fills in is not an error.
    expect(args({ action: 'review', resolve: false })).toEqual([])
  })

  test('session ids normalize from what an agent may type', () => {
    expect(normalizePlannotatorSessionId('3F2A9C')).toBe('pn-3f2a9c')
    expect(normalizePlannotatorSessionId('pn-3f2a9')).toBeNull()
    expect(normalizePlannotatorSessionId('pn-3f2a9cz')).toBeNull()
  })
})

describe('plannotator tool v2: texts name the session id', () => {
  // The failure: the agent cannot tie a decision message or a list line back
  // to the review it opened, so it cannot close the right one.
  test('opened text leads with the id; the decision heading carries it', () => {
    expect(plannotatorToolOpenedText('notes.md', 'http://localhost:1', false, 'pn-3f2a9c').split('\n')[0]).toBe('Session: pn-3f2a9c')
    expect(plannotatorToolOpenedText('notes.md', 'http://localhost:1', false)).not.toContain('Session:')
    expect(plannotatorDecisionHeading('notes.md', 'pn-3f2a9c', 'Feedback · 3 comments')).toBe('Plannotator: notes.md (pn-3f2a9c) — Feedback · 3 comments.')
    expect(plannotatorDecisionHeading('notes.md', undefined, 'Approved')).toBe('Plannotator: notes.md — Approved.')
  })

  test('list reports each review once with its unsent count, unknown when the server cannot say', () => {
    const text = plannotatorToolListText([
      { id: 'pn-aaaaaa', kind: 'annotate', subject: 'notes.md', url: 'http://localhost:1', ageMs: 5 * 60_000, state: 'open', unsent: 2 },
      { id: 'pn-bbbbbb', kind: 'plan', subject: 'Plan v1', ageMs: 0, state: 'starting', unsent: null },
    ])
    const lines = text.split('\n')
    expect(lines.filter((line) => line.startsWith('pn-aaaaaa'))[0]).toContain('unsent: 2')
    expect(lines.filter((line) => line.startsWith('pn-bbbbbb'))[0]).toContain('unsent: unknown')
    expect(text).toContain('5 min')
  })

  test('close reports the saved count per review and refuses plan reviews', () => {
    const text = plannotatorToolCloseText([
      { id: 'pn-aaaaaa', subject: 'notes.md', closed: true, unsent: 3 },
      { id: 'pn-bbbbbb', subject: 'Plan v2', closed: false, reason: 'plan' },
    ])
    expect(text).toContain('pn-aaaaaa')
    expect(text).toContain('3 unsent comments')
    expect(text).toMatch(/Not closed: Plan v2 \(pn-bbbbbb\)/)
  })
})
