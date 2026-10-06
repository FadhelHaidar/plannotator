import { describe, expect, test } from 'bun:test'
import { PlannotatorMod } from './controller'
import { fakeHost, type FakeHost, type RunCall } from './testing/fake-host'

// The failure these guard (a real report): an approval for
// releases-2026-10-04/QUESTIONS.md arrived as "Plannotator: QUESTIONS.md —
// Approved." with no path, and the agent took the File: line of an earlier
// decision about a DIFFERENT QUESTIONS.md and acted on the wrong file.

const SESSION = { sessionId: 'session-1', dataDir: '/data', interactive: true }
const NEW = '/work/releases-2026-10-04/QUESTIONS.md'
const OLD = '/work/releases-2026-09-20/QUESTIONS.md'

function isLaunch(call: RunCall): boolean {
  return call.argv[0] === '/bin/sh' && call.argv[3] === 'plannotator-launch'
}

function dirOf(call: RunCall): string {
  return call.argv[4] as string
}

/** The CLI comes up for each launch on its own port, naming `targets[i]` (or nothing: an older CLI). */
function serve(host: FakeHost, targets: (string | undefined)[], cwd = '/work') {
  let index = 0
  host.onRun = (call) => {
    if (call.argv[3] === 'plannotator-mkdir') return { exitCode: 0, stdout: `${cwd}\n`, stderr: '' }
    if (!isLaunch(call)) return undefined
    const target = targets[index]
    const port = 4000 + index
    index += 1
    host.files.set(
      `${dirOf(call)}/ready`,
      `${JSON.stringify({ url: `http://localhost:${port}`, isRemote: false, port, ...(target ? { target } : {}) })}\n`,
    )
    return undefined
  }
}

function launches(host: FakeHost): RunCall[] {
  return host.runs.filter(isLaunch)
}

function decide(host: FakeHost, call: RunCall, record: Record<string, unknown>) {
  host.files.set(`${dirOf(call)}/result.json`, JSON.stringify({ v: 1, ...record }))
}

const APPROVED = { surface: 'annotate', decision: 'approved', message: 'The user approved.', noop: true }

describe('decision targets (two files named QUESTIONS.md)', () => {
  test('each decision names its own full path, and the subjects are told apart', async () => {
    const host = fakeHost()
    serve(host, [OLD, NEW])
    const mod = new PlannotatorMod(host, SESSION)

    const first = await mod.runTool({ action: 'annotate', target: 'releases-2026-09-20/QUESTIONS.md', gate: true })
    const second = await mod.runTool({ action: 'annotate', target: 'releases-2026-10-04/QUESTIONS.md', gate: true })

    // The tool's own text names the full path the server opened.
    expect('text' in second && second.text).toContain(`Target: ${NEW}`)
    expect('text' in first && first.text).toContain(`Target: ${OLD}`)
    // Two open reviews of a QUESTIONS.md: the status line tells them apart.
    expect(host.statuses.at(-1)).toContain('releases-2026-09-20/QUESTIONS.md')
    expect(host.statuses.at(-1)).toContain('releases-2026-10-04/QUESTIONS.md')

    const [oldLaunch, newLaunch] = launches(host)
    decide(host, oldLaunch!, { surface: 'annotate', decision: 'annotated', message: `File: ${OLD}\n\nfix it`, noop: false, target: OLD })
    await host.tick()
    decide(host, newLaunch!, { ...APPROVED, target: NEW })
    await host.tick()

    expect(host.submits).toHaveLength(2)
    expect(host.submits[0]).toContain(`Target: ${OLD}`)
    // The bare approval: the heading names the right file in full, and never the other one.
    const approval = host.submits[1] as string
    expect(approval.split('\n')[0]).toContain('releases-2026-10-04/QUESTIONS.md')
    expect(approval.split('\n')[0]).toContain('Approved')
    expect(approval).toContain(`Target: ${NEW}`)
    expect(approval).not.toContain(OLD)
  })

  test('an older CLI (no target anywhere): the mod names what it resolved against the session directory', async () => {
    const host = fakeHost()
    serve(host, [undefined])
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runTool({ action: 'annotate', target: 'releases-2026-10-04/QUESTIONS.md', gate: true })
    decide(host, launches(host)[0]!, APPROVED)
    await host.tick()

    expect(host.submits[0]).toContain(`Target: ${NEW}`)
    expect(host.logs.join('\n')).not.toContain('as recorded when it opened')
  })

  test("the record's target wins over the launch's, and a difference is said", async () => {
    const host = fakeHost()
    serve(host, [NEW])
    const mod = new PlannotatorMod(host, SESSION)

    await mod.runTool({ action: 'annotate', target: 'releases-2026-10-04/QUESTIONS.md', gate: true })
    decide(host, launches(host)[0]!, { ...APPROVED, target: OLD })
    await host.tick()

    expect(host.submits[0]).toContain(`Target: ${OLD}`)
    expect(host.submits[0]).not.toContain(`Target: ${NEW}`)
    expect(host.logs.join('\n')).toContain('as recorded when it opened')
  })

  test('the launch passes its pn- id to the CLI for the sessions registry', async () => {
    const host = fakeHost()
    serve(host, [NEW])
    const mod = new PlannotatorMod(host, SESSION)

    const opened = await mod.runTool({ action: 'annotate', target: NEW })

    const id = /Session: (pn-[0-9a-f]{6})/.exec('text' in opened ? opened.text : '')?.[1]
    expect(id).toBeDefined()
    expect(launches(host)[0]?.env?.PLANNOTATOR_HOST_REVIEW_ID).toBe(id)
  })
})
