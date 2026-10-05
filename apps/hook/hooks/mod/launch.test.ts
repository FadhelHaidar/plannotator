import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STOP_EXIT, stopArgv } from './launch'

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
