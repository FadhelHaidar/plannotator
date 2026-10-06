import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAIM_EXIT, claimArgv, debugAppendArgv, pruneArgv, STOP_EXIT, stopArgv } from './launch'

// The TERM fallback for an older CLI runs this script for real. The failures
// it guards: signalling a pid that no longer belongs to Plannotator (reused
// after a reboot or crash), or killing a CLI whose decision is already on disk.
describe('stopArgv (TERM for a CLI without host close)', () => {
  const children: ReturnType<typeof Bun.spawn>[] = []
  const dirs: string[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function spawn(script: string) {
    const child = Bun.spawn(['/bin/sh', '-c', script], { stdout: 'ignore', stderr: 'ignore' })
    children.push(child)
    return child
  }

  async function stop(pid: number, decidedFiles: string[]): Promise<number> {
    const proc = Bun.spawn(stopArgv(String(pid), decidedFiles), { stdout: 'ignore', stderr: 'ignore' })
    return proc.exited
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'plannotator-stop-'))
    dirs.push(dir)
    return dir
  }

  test('a plannotator process is stopped', async () => {
    const child = spawn('sleep 30; : plannotator review')
    const dir = tempDir()
    expect(await stop(child.pid, [join(dir, 'result.json'), join(dir, 'exit')])).toBe(STOP_EXIT.stopped)
    await child.exited
    expect(alive(child.pid)).toBe(false)
  })

  test('a pid that is not plannotator is left alone', async () => {
    const child = spawn('sleep 30; : something-else')
    expect(await stop(child.pid, [])).toBe(STOP_EXIT.notPlannotator)
    expect(alive(child.pid)).toBe(true)
  })

  // No ps (Debian slim without procps; BusyBox's has no -p): the pid cannot be
  // verified, so nothing is signalled and the close says so.
  test('a system whose ps cannot verify the pid: nothing is signalled', async () => {
    const child = spawn('sleep 30; : plannotator review')
    const emptyPath = tempDir()
    const proc = Bun.spawn(stopArgv(String(child.pid), []), { stdout: 'ignore', stderr: 'ignore', env: { PATH: emptyPath } })
    expect(await proc.exited).toBe(STOP_EXIT.cannotVerify)
    expect(alive(child.pid)).toBe(true)
  })

  test('a decision already on disk wins: nothing is signalled', async () => {
    const child = spawn('sleep 30; : plannotator review')
    const dir = tempDir()
    writeFileSync(join(dir, 'result.json'), '{}')
    expect(await stop(child.pid, [join(dir, 'result.json'), join(dir, 'exit')])).toBe(STOP_EXIT.decided)
    expect(alive(child.pid)).toBe(true)
  })
})

// These scripts are what keeps two Claude Code processes on one session from
// delivering a decision twice, the store from growing forever, and a shared
// debug log from being clobbered; they run for real here.
describe('the scripts several Claude Code processes share', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'plannotator-mod-'))
    dirs.push(dir)
    return dir
  }

  async function run(argv: string[], stdin?: string): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(argv, {
      stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const stdout = await new Response(proc.stdout).text()
    return { code: await proc.exited, stdout }
  }

  test('a claim has exactly one winner, even when both run at once', async () => {
    const result = join(tempDir(), 'result.json')
    writeFileSync(result, '{"v":1}')
    const answers = await Promise.all([run(claimArgv(result)), run(claimArgv(result))])
    expect(answers.map((answer) => answer.code).sort()).toEqual([CLAIM_EXIT.won, CLAIM_EXIT.lost])
    expect(readFileSync(`${result}.claimed`, 'utf8')).toBe('{"v":1}')
    expect(existsSync(result)).toBe(false)
  })

  test('prune names cleaned-up launches, and dead servers only where asked; a decision or a live server stays', async () => {
    const root = tempDir()
    const dir = (name: string, files: Record<string, string>) => {
      mkdirSync(join(root, name))
      for (const [file, text] of Object.entries(files)) writeFileSync(join(root, name, file), text)
      return join(root, name)
    }
    const cleaned = dir('cleaned', { 'feedback.md': 'kept for Claude' })
    const removed = join(root, 'removed')
    const ownDead = dir('own-dead', { stdin: '', pid: '999999' })
    const live = dir('live', { stdin: '', pid: String(process.pid) })
    const dead = dir('dead', { stdin: '', pid: '999998' })
    const decided = dir('decided', { stdin: '', pid: '999997', 'result.json': '{}' })
    const exited = dir('exited', { stdin: '', pid: '999996', exit: '0' })

    const { code, stdout } = await run(pruneArgv([cleaned, removed, ownDead], [live, dead, decided, exited]))

    expect(code).toBe(0)
    expect(stdout.trim().split('\n').sort()).toEqual([cleaned, dead, removed].sort())
  })

  test('debug lines from several writers are appended, never overwritten', async () => {
    const log = join(tempDir(), 'claude-code-mod', 'debug.log')
    await Promise.all([run(debugAppendArgv(log), 'one\n'), run(debugAppendArgv(log), 'two\n')])
    await run(debugAppendArgv(log), 'three\n')
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(lines.sort()).toEqual(['one', 'three', 'two'])
  })
})
