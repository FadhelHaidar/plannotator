/**
 * The Plannotator mod's state for one Claude Code session: the reviews it has
 * open, the plan approval waiting for Claude's next ExitPlanMode, delivery of
 * decisions as plugin turns, and the "Ask this session" bridges.
 *
 * Every engine call goes through `Host` (built from `$` in register.ts), so
 * bun tests drive this class with a host made of memory.
 */

import { BRIDGE_HOST, BRIDGE_MODES, bridgeBaseUrl, createBridge, type BridgeHandle } from './bridge'
import { deliveryFor, legacyResult, parseHostResult, type HostResultRecord, type SessionKind } from './delivery'
import type { Host, HttpResult } from './host'
import {
  aliveArgv,
  cleanupArgv,
  stopArgv,
  STOP_EXIT,
  cliArgvFor,
  failedText,
  fileIn,
  isSeveralFilePaths,
  launchArgv,
  launchDirOf,
  openedText,
  parseReadyFile,
  pickerFile,
  privateDirArgv,
  RECENT_MESSAGES_SUBJECT,
  recentAssistantTexts,
  subjectFor,
  wordsOf,
} from './launch'
import {
  approvedPermissionDecision,
  CLASSIC_PLAN_RETRY_TEXT,
  CLASSIC_PLAN_REVIEW_TEXT,
  cliLacksModPlan,
  decidingDenyText,
  isTrustablePlanPath,
  MAX_PLAN_FILE_BYTES,
  normalizePlanForHash,
  planCallAction,
  planWaitingStatus,
  revisedDenyText,
  revisionPendingDenyText,
  unchangedDenyText,
  waitingDenyText,
  type OpenPlanReview,
  type PendingApproval,
} from './plan'
import {
  isOlderCliBundleRefusal,
  parsePlannotatorToolInput,
  plannotatorBundleSubject,
  plannotatorSessionId,
  plannotatorToolArgs,
  plannotatorToolCloseText,
  plannotatorToolListText,
  plannotatorToolOpenedText,
  plannotatorToolTargets,
  plannotatorUnknownSessionText,
  PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
  scriptOnlyAnnotateFlag,
  scriptOnlyAnnotateFlagText,
  type PlannotatorCloseOutcome,
  type PlannotatorSessionSummary,
} from './tool'
import { TurnTracker, type EnteredPrompt } from './turns'

/** Persisted in `$.store` so open reviews reattach after a restart or `--resume`. */
export interface LaunchRecord {
  id: string
  sessionId: string
  kind: SessionKind
  dir: string
  subject: string
  startedAt: number
  url?: string
  port?: number
  /** Plan: the version shown in the copy. */
  version?: number
  /** Plan: the last revision sequence written to revision.json. */
  revisionSeq?: number
  /** The pull-bridge token this launch's server was started with. */
  bridgeToken?: string
  /**
   * Opened by Claude's `plannotator` tool with `gate: true`: Claude was told
   * to wait for the sign-off, so a bare approval is delivered as a turn (the
   * slash command's bare approval only logs).
   */
  deliverApproval?: boolean
  /**
   * Claude closed this review (the `plannotator` tool's `close`): nothing is
   * delivered for it, and it is gone from `list` and the status line while
   * the server shuts down.
   */
  closedByAgent?: boolean
}

/** The `pn-` session id of a launch: the six hex digits that end its launch id. */
export function sessionIdOf(launch: { id: string }): string {
  const hex = /([0-9a-f]{6})$/i.exec(launch.id)?.[1] ?? '000000'
  return plannotatorSessionId(hex)
}

/** The host-only endpoints of the CLI's server (packages/shared/host-control.ts). */
export const HOST_STATUS_PATH = '/api/host/status'
export const HOST_CLOSE_PATH = '/api/host/close'
/** The code a current CLI's 404 carries while host control is off (packages/shared/host-control.ts). */
export const HOST_CONTROL_DISABLED_CODE = 'host_control_disabled'

function jsonObjectOf(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** What `POST /api/host/close` told the mod. */
export type HostCloseAnswer =
  | { kind: 'closed'; unsent: number }
  | { kind: 'decided' }
  /** A Plannotator without the endpoint answered: a JSON 404 (0.24+) or its app page (0.19.24–0.23.x). */
  | { kind: 'older' }
  /** A Plannotator WITH the endpoint, turned off (remote mode): `404 { code: "host_control_disabled" }`. */
  | { kind: 'disabled' }
  | { kind: 'refused'; status: number }
  /** Nothing answered on the port. */
  | { kind: 'unreachable' }

/**
 * Reads the close answer. Only a JSON body with a numeric `unsentAnnotations`
 * is a close: a CLI before the `/api/*` 404 guard (#748) serves its app page
 * with 200 for any path, which must not read as closed (the reviewer's later
 * decision would be swallowed as the agent's close).
 */
export function classifyHostCloseAnswer(response: HttpResult | null): HostCloseAnswer {
  if (!response) return { kind: 'unreachable' }
  const body = jsonObjectOf(response.text)
  if (body) {
    if (response.ok && typeof body.unsentAnnotations === 'number') return { kind: 'closed', unsent: body.unsentAnnotations }
    if (response.status === 409 && body.code === 'already_decided') return { kind: 'decided' }
    if (response.status === 404 && body.code === HOST_CONTROL_DISABLED_CODE) return { kind: 'disabled' }
    if (response.status === 404 && typeof body.error === 'string') return { kind: 'older' }
    return { kind: 'refused', status: response.status }
  }
  if (response.status === 200 && /<html|<!doctype html/i.test(response.text)) return { kind: 'older' }
  return { kind: 'refused', status: response.status }
}

export const STORE_LAUNCHES = 'launches'
export const STORE_APPROVALS = 'approvals'

const TICK_MS = 1_000
/** Liveness check of a launch whose server has not decided yet. */
const PID_CHECK_EVERY_TICKS = 15
const PID_MISSES_BEFORE_STOPPED = 3
const READY_WAIT_MS = { review: 45_000, other: 15_000 }
const REVISION_ACK_WAIT_MS = 4_000

interface LiveLaunch extends LaunchRecord {
  pidMisses: number
  ticks: number
  settling: boolean
  /**
   * A hook is still waiting in `awaitReady` for this launch to come up or
   * fail: that hook reports the outcome, so the timer leaves the launch alone.
   */
  starting: boolean
  bridge: BridgeHandle | null
}

export interface SessionInfo {
  sessionId: string
  dataDir: string
  interactive: boolean
}

export class PlannotatorMod {
  readonly turns = new TurnTracker()
  private launches = new Map<string, LiveLaunch>()
  private approval: PendingApproval | null = null
  /** ExitPlanMode calls passed through as the approved plan, by tool_use_id. */
  private passing = new Map<string, PendingApproval>()
  private planVersion = 0
  /**
   * The CLI has no `claude-mod-plan` (it is older than the plugin): every
   * ExitPlanMode of this session takes Claude Code's own flow, and the
   * plugin's classic hook reviews it, blocking, as before the mod.
   */
  private classicPlanReview = false
  private timer: { cancel: () => void } | null = null
  private delivering: Promise<void> = Promise.resolve()
  private sequence = 0
  private disposed = false

  constructor(
    private readonly host: Host,
    readonly session: SessionInfo,
  ) {}

  // --- Lifecycle -----------------------------------------------------------

  /** Reattach the reviews this session left open (restart, `--resume`). */
  async restore(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const records = Array.isArray(stored) ? (stored as LaunchRecord[]) : []
    const mine = records.filter((record) => record && record.sessionId === this.session.sessionId && typeof record.dir === 'string')
    for (const record of mine) this.adopt(record)
    const approvals = await this.host.storeGet(STORE_APPROVALS)
    const approval = approvals && typeof approvals === 'object' ? (approvals as Record<string, PendingApproval>)[this.session.sessionId] : undefined
    if (approval && typeof approval.hash === 'string') this.approval = approval
    for (const launch of this.launches.values()) {
      if (launch.kind === 'plan') this.planVersion = Math.max(this.planVersion, launch.version ?? 0)
    }
    if (mine.length > 0) {
      const names = mine.map((record) => record.subject).join(', ')
      this.host.log(`Reattached ${mine.length} open ${mine.length === 1 ? 'session' : 'sessions'} (${names}).`)
      this.ensureTimer()
      this.refreshStatus()
    }
  }

  /**
   * The session this instance serves ended (`/clear`, an in-process resume,
   * exit). Stop watching and polling so nothing is delivered into whatever
   * session the process goes on with; open reviews stay in the store under
   * this session id and reattach when it is resumed.
   */
  dispose(): void {
    this.disposed = true
    this.timer?.cancel()
    this.timer = null
    this.host.status(undefined)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  private adopt(record: LaunchRecord): LiveLaunch {
    const live: LiveLaunch = { ...record, pidMisses: 0, ticks: 0, settling: false, starting: false, bridge: null }
    this.launches.set(record.id, live)
    return live
  }

  private async persist(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const others = (Array.isArray(stored) ? (stored as LaunchRecord[]) : []).filter(
      (record) => record && record.sessionId !== this.session.sessionId,
    )
    const mine: LaunchRecord[] = [...this.launches.values()].map(
      ({ pidMisses: _misses, ticks: _ticks, settling: _settling, starting: _starting, bridge: _bridge, ...record }) => record,
    )
    await this.host.storeSet(STORE_LAUNCHES, [...others, ...mine])
  }

  private async persistApproval(): Promise<void> {
    const stored = await this.host.storeGet(STORE_APPROVALS)
    const all = stored && typeof stored === 'object' ? { ...(stored as Record<string, PendingApproval>) } : {}
    if (this.approval) all[this.session.sessionId] = this.approval
    else delete all[this.session.sessionId]
    await this.host.storeSet(STORE_APPROVALS, all)
  }

  private ensureTimer(): void {
    if (this.disposed || this.timer || this.launches.size === 0) return
    this.timer = this.host.every(TICK_MS, () => {
      void this.tick()
    })
  }

  private stopTimerIfIdle(): void {
    if (this.launches.size === 0 && this.timer) {
      this.timer.cancel()
      this.timer = null
    }
  }

  /** A launch id whose last six hex digits (its `pn-` session id) no open launch of this session uses. */
  private async newLaunchId(): Promise<string> {
    this.sequence += 1
    const used = new Set([...this.launches.values()].map((launch) => sessionIdOf(launch)))
    let value = Number.parseInt(this.host.randomHex(3), 16) || 0
    let hex = value.toString(16).padStart(6, '0')
    while (used.has(plannotatorSessionId(hex))) {
      value = (value + 1) % 0x1000000
      hex = value.toString(16).padStart(6, '0')
    }
    return `${await this.host.now()}-${this.sequence}-${hex}`
  }

  // --- Launch --------------------------------------------------------------

  private async launch(
    kind: SessionKind,
    cliArgv: string[],
    subject: string,
    stdin: string | ((dir: string) => string),
    extra: Partial<LaunchRecord> = {},
    side: { messages?: string } = {},
  ): Promise<LiveLaunch | { error: string }> {
    const id = await this.newLaunchId()
    const dir = launchDirOf(this.session.dataDir, this.session.sessionId, id)
    const bridgeToken = this.host.randomHex(32)
    try {
      // Owner-only before anything lands in it (stdin holds the plan or message).
      const made = await this.host.run(privateDirArgv(dir), { timeoutMs: 5_000 })
      if (made.exitCode !== 0) return { error: made.stderr.trim() || `could not create ${dir}` }
      await this.host.writeFile(fileIn(dir, 'stdin'), typeof stdin === 'function' ? stdin(dir) : stdin)
      // `last`'s picker list. A CLI that predates the variable ignores it and
      // opens the newest message from stdin, as before.
      if (side.messages !== undefined) await this.host.writeFile(fileIn(dir, 'messages'), side.messages)
      const result = await this.host.run(launchArgv(dir, cliArgv), {
        env: {
          PLANNOTATOR_READY_FILE: fileIn(dir, 'ready'),
          PLANNOTATOR_HOST_RESULT_FILE: fileIn(dir, 'result'),
          ...(side.messages !== undefined ? { PLANNOTATOR_HOST_MESSAGES_FILE: fileIn(dir, 'messages') } : {}),
          PLANNOTATOR_SESSION_BRIDGE_TOKEN: bridgeToken,
          PLANNOTATOR_SESSION_BRIDGE_HOST: BRIDGE_HOST,
          PLANNOTATOR_SESSION_BRIDGE_MODES: BRIDGE_MODES,
        },
        timeoutMs: 15_000,
      })
      if (result.exitCode !== 0) return { error: result.stderr.trim() || `launcher exited ${result.exitCode}` }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    const record: LaunchRecord = { id, sessionId: this.session.sessionId, kind, dir, subject, startedAt: await this.host.now(), bridgeToken, ...extra }
    const live = this.adopt(record)
    this.host.debug(`launched ${kind} ${id}: ${cliArgv.join(' ')}`)
    await this.persist()
    this.ensureTimer()
    return live
  }

  /**
   * Wait until the server is listening or the CLI exited, up to `ms`. Called
   * from hooks, so the waiting happens in `waitForAny` (a process call), never
   * in a `$.clock` wait that would spend the hook's budget.
   */
  private async awaitReady(launch: LiveLaunch, ms: number): Promise<'ready' | 'exited' | 'timeout'> {
    launch.starting = true
    try {
      return await this.waitReadyOrExit(launch, ms)
    } finally {
      launch.starting = false
    }
  }

  private async waitReadyOrExit(launch: LiveLaunch, ms: number): Promise<'ready' | 'exited' | 'timeout'> {
    const ready = fileIn(launch.dir, 'ready')
    const exit = fileIn(launch.dir, 'exit')
    const deadline = (await this.host.now()) + ms
    for (;;) {
      if (await this.readReady(launch)) return 'ready'
      if (await this.host.exists(exit)) {
        // A last look: the CLI may have become ready and exited at once.
        return (await this.readReady(launch)) ? 'ready' : 'exited'
      }
      const left = deadline - (await this.host.now())
      if (left <= 0) return 'timeout'
      // The ready file appears before its JSON line is complete; re-check shortly.
      await this.host.waitForAny([ready, exit], (await this.host.exists(ready)) ? 200 : left)
    }
  }

  private async readReady(launch: LiveLaunch): Promise<boolean> {
    if (launch.url) return true
    const path = fileIn(launch.dir, 'ready')
    if (!(await this.host.exists(path))) return false
    const ready = parseReadyFile(await this.host.readFile(path).catch(() => ''))
    if (!ready) return false
    launch.url = ready.url
    launch.port = ready.port
    await this.persist()
    this.refreshStatus()
    return true
  }

  private async startupFailure(launch: LiveLaunch): Promise<string> {
    const read = (name: 'stderr' | 'stdout' | 'exit') => this.host.readFile(fileIn(launch.dir, name)).catch(() => '')
    const code = Number.parseInt((await read('exit')).trim(), 10)
    const text = failedText(launch.subject, await read('stderr'), await read('stdout'), Number.isFinite(code) ? code : null)
    await this.forget(launch)
    return text
  }

  /**
   * Not a failure to report each time: an older CLI. Say so once, and leave
   * this instance's plans to the classic review (a resumed session probes
   * once more, so a CLI updated in between is picked up).
   */
  private async fallBackToClassicPlans(launch: LiveLaunch): Promise<void> {
    this.classicPlanReview = true
    await this.forget(launch)
    await this.host.run(cleanupArgv(launch.dir), { timeoutMs: 5_000 }).catch(() => undefined)
    this.host.log(CLASSIC_PLAN_REVIEW_TEXT)
  }

  /** The plan launch exited because the CLI has no `claude-mod-plan`. */
  private async lacksModPlan(launch: LiveLaunch): Promise<boolean> {
    const stderr = await this.host.readFile(fileIn(launch.dir, 'stderr')).catch(() => '')
    return cliLacksModPlan(stderr)
  }

  // --- Commands ------------------------------------------------------------

  /** `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`: open and return at once. */
  async runCommand(kind: Exclude<SessionKind, 'plan'>, rawArgs: string): Promise<string> {
    const opened = await this.open(kind, rawArgs, subjectFor(kind, rawArgs))
    switch (opened.state) {
      case 'error':
        // Several file paths given to a CLI that predates reviews of several
        // files: say to update instead of showing its "pick one" error.
        if (kind === 'annotate' && isOlderCliBundleRefusal(opened.text) && isSeveralFilePaths(wordsOf(rawArgs))) {
          return PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT
        }
        return opened.text
      case 'starting':
        return `Starting Plannotator for ${opened.subject}… it opens in your browser when ready, and your feedback comes back here as a message.`
      case 'ready':
        return openedText(kind, opened.subject, opened.url, opened.extra)
    }
  }

  /**
   * Claude's `plannotator` tool: the same launch as the slash command, with
   * the call's validated arguments (never re-split). `{ deny }` is an error
   * result for Claude (a bad call, or the CLI's startup error); `{ text }`
   * tells Claude the page is open and to end its turn and wait.
   */
  async runTool(input: unknown): Promise<{ text: string } | { deny: string }> {
    const parsed = parsePlannotatorToolInput(input)
    if (!parsed.ok) return { deny: parsed.error }
    const call = parsed.input
    switch (call.action) {
      case 'list':
        return { text: await this.listText() }
      case 'close':
        return this.closeSessions(call.session as string)
      case 'annotate':
      case 'review':
      case 'last':
        break
    }
    const action = call.action
    const gate = call.gate === true
    const targets = plannotatorToolTargets(call)
    // A list of files is one review of all of them (a bundle), named as such.
    const bundle = Array.isArray(call.target)
    const subject = bundle ? plannotatorBundleSubject(targets) : subjectFor(action, targets)
    const opened = await this.open(action, plannotatorToolArgs(call), subject, gate ? { deliverApproval: true } : {})
    switch (opened.state) {
      case 'error':
        // An older CLI answers several paths with its ambiguity error.
        if (bundle && isOlderCliBundleRefusal(opened.text)) return { deny: PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT }
        return { deny: opened.text }
      case 'starting':
        return { text: plannotatorToolOpenedText(opened.subject, undefined, gate, opened.sessionId) }
      case 'ready':
        return { text: plannotatorToolOpenedText(opened.subject, opened.url, gate, opened.sessionId) }
    }
  }

  // --- The agent's own sessions (list, close) ------------------------------

  /** The reviews this Claude session opened that are still open (not settling, not closed by Claude). */
  private openLaunches(): LiveLaunch[] {
    return [...this.launches.values()].filter((launch) => !launch.settling && !launch.closedByAgent)
  }

  private hostHeaders(launch: LiveLaunch): Record<string, string> {
    return { authorization: `Bearer ${launch.bridgeToken ?? ''}` }
  }

  /** `GET /api/host/status`, or null when the server cannot say (not up yet, an older CLI). */
  private async hostStatus(launch: LiveLaunch): Promise<{ unsent: number; decided: boolean } | null> {
    if (!launch.port || !launch.bridgeToken) return null
    try {
      const response = await this.host.fetch(`${bridgeBaseUrl(launch.port)}${HOST_STATUS_PATH}`, {
        method: 'GET',
        headers: this.hostHeaders(launch),
      })
      if (!response.ok) return null
      // An older CLI answers its app page (200 text/html) or a JSON 404: no count.
      const body = jsonObjectOf(response.text)
      if (!body || typeof body.unsentAnnotations !== 'number') return null
      return { unsent: body.unsentAnnotations, decided: body.decided === true }
    } catch {
      return null
    }
  }

  /** The tool's `list`: every open review of THIS Claude session (the launch store is per session). */
  async listText(): Promise<string> {
    const now = await this.host.now()
    const sessions: PlannotatorSessionSummary[] = []
    for (const launch of this.openLaunches()) {
      if (!launch.url) await this.readReady(launch).catch(() => false)
      const status = launch.url ? await this.hostStatus(launch) : null
      sessions.push({
        id: sessionIdOf(launch),
        kind: launch.kind,
        subject: launch.subject,
        ...(launch.url ? { url: launch.url } : {}),
        ageMs: now - launch.startedAt,
        state: !launch.url ? 'starting' : status?.decided ? 'decided' : 'open',
        unsent: status ? status.unsent : null,
      })
    }
    return plannotatorToolListText(sessions)
  }

  /** The tool's `close`: one id or "all", only among this Claude session's reviews. */
  private async closeSessions(session: string): Promise<{ text: string } | { deny: string }> {
    if (session === 'all') {
      const outcomes: PlannotatorCloseOutcome[] = []
      for (const launch of this.openLaunches()) outcomes.push(await this.closeLaunch(launch))
      return { text: plannotatorToolCloseText(outcomes) }
    }
    const launch = this.openLaunches().find((candidate) => sessionIdOf(candidate) === session)
    if (!launch) return { deny: plannotatorUnknownSessionText(session) }
    const outcome = await this.closeLaunch(launch)
    const text = plannotatorToolCloseText([outcome])
    return outcome.closed ? { text } : { deny: text }
  }

  /**
   * Close one review: the server's host close (the reviewer's Close, draft
   * kept, the tab told), or for a CLI without it a TERM to the process (which
   * never deletes a draft). Plan reviews end only with a decision.
   */
  private async closeLaunch(launch: LiveLaunch): Promise<PlannotatorCloseOutcome> {
    const id = sessionIdOf(launch)
    const subject = launch.subject
    if (launch.kind === 'plan') return { id, subject, closed: false, reason: 'plan' }
    if (!launch.port) {
      return { id, subject, closed: false, reason: 'failed', detail: 'its server has not started yet; try again in a moment' }
    }
    const response = await this.host
      .fetch(`${bridgeBaseUrl(launch.port)}${HOST_CLOSE_PATH}`, {
        method: 'POST',
        headers: { ...this.hostHeaders(launch), 'content-type': 'application/json' },
        body: '{}',
      })
      .catch(() => null)
    const answer = classifyHostCloseAnswer(response)
    switch (answer.kind) {
      case 'closed':
        await this.markClosedByAgent(launch)
        return { id, subject, closed: true, unsent: answer.unsent }
      case 'decided':
        // The reviewer decided first: that decision is on its way.
        return { id, subject, closed: false, reason: 'decided' }
      case 'unreachable':
        // Nothing answers on its port: the server is gone (the timer reports
        // that) or the pid is stale. Never signal a pid on a guess.
        return { id, subject, closed: false, reason: 'failed', detail: 'its server is not answering' }
      case 'refused':
        return { id, subject, closed: false, reason: 'failed', detail: `its server refused the close (HTTP ${answer.status})` }
      case 'disabled':
        // A current CLI that turned host control off (remote mode): its
        // process is not ours to signal.
        return {
          id,
          subject,
          closed: false,
          reason: 'failed',
          detail: 'it runs in remote mode, where Plannotator turns host close off; close it from the tab',
        }
      case 'older':
        return this.stopOlderCli(launch, id, subject)
    }
  }

  /**
   * An older Plannotator (no host close) answered on the launch's port: TERM
   * its process, unless the reviewer's decision is already on disk or the pid
   * no longer names a plannotator process (`STOP_SCRIPT`). A decision such a
   * CLI is still publishing (it waits 1.5 s after the reviewer decides) cannot
   * be seen and is lost; see "Version skew" in AGENTS.md.
   */
  private async stopOlderCli(launch: LiveLaunch, id: string, subject: string): Promise<PlannotatorCloseOutcome> {
    const pid = (await this.host.readFile(fileIn(launch.dir, 'pid')).catch(() => '')).trim()
    if (!/^\d+$/.test(pid)) return { id, subject, closed: false, reason: 'failed', detail: 'its server has not started yet; try again in a moment' }
    const stopped = await this.host
      .run(stopArgv(pid, [fileIn(launch.dir, 'result'), fileIn(launch.dir, 'exit')]), { timeoutMs: 5_000 })
      .catch(() => null)
    switch (stopped?.exitCode) {
      case STOP_EXIT.stopped:
        await this.markClosedByAgent(launch)
        return { id, subject, closed: true, unsent: null }
      case STOP_EXIT.decided:
        return { id, subject, closed: false, reason: 'decided' }
      case STOP_EXIT.notPlannotator:
        return { id, subject, closed: false, reason: 'failed', detail: 'its server process is gone' }
      case STOP_EXIT.cannotVerify:
        return {
          id,
          subject,
          closed: false,
          reason: 'failed',
          detail: "this system's ps could not verify the review's process, so it was left running; close it from the tab",
        }
      default:
        return { id, subject, closed: false, reason: 'failed', detail: 'its server could not be stopped' }
    }
  }

  private async markClosedByAgent(launch: LiveLaunch): Promise<void> {
    launch.closedByAgent = true
    await this.persist()
    this.refreshStatus()
    this.ensureTimer()
  }

  /** A review Claude closed has exited (or published its dismissal): forget it, log one line, deliver nothing. */
  private async finishAgentClose(launch: LiveLaunch, record: HostResultRecord | null): Promise<void> {
    launch.settling = true
    await this.forget(launch)
    const unsent = record?.unsentAnnotations
    const saved = typeof unsent === 'number' && unsent > 0 ? ` ${unsent} unsent ${unsent === 1 ? 'comment' : 'comments'} kept in the draft.` : ''
    this.host.log(`Claude closed ${launch.subject} (${sessionIdOf(launch)}).${saved} Nothing was sent to Claude.`)
    await this.host.run(cleanupArgv(launch.dir), { timeoutMs: 5_000 }).catch(() => undefined)
  }

  /** The launch both entry points share: detached CLI, result later as a plugin turn, bridge, cleanup. */
  private async open(
    kind: Exclude<SessionKind, 'plan'>,
    args: string | readonly string[],
    subject: string,
    record: Partial<LaunchRecord> = {},
  ): Promise<
    | { state: 'error'; text: string }
    | { state: 'starting'; subject: string; sessionId: string }
    | { state: 'ready'; subject: string; url: string; sessionId: string; extra?: string }
  > {
    if (kind === 'annotate') {
      // Strict gates and --hook answer on the CLI's exit code, stdout or result
      // file, which nothing reads under a detached launch: refuse up front.
      const flag = scriptOnlyAnnotateFlag(wordsOf(args))
      if (flag) return { state: 'error', text: scriptOnlyAnnotateFlagText(flag) }
    }
    let stdin = ''
    let extra: string | undefined
    const side: { messages?: string } = {}
    if (kind === 'last') {
      const texts = recentAssistantTexts(await this.host.messages())
      const text = texts[0]
      if (!text) return { state: 'error', text: 'There is no assistant message to annotate yet.' }
      // stdin always carries the newest text: all an older CLI reads.
      stdin = text
      const picker = await pickerFile(texts, (value) => this.host.sha256(value))
      if (picker.messages.length > 1) {
        side.messages = picker.json
        subject = RECENT_MESSAGES_SUBJECT
        extra = `${picker.messages.length} messages, newest first`
      } else {
        const words = text.trim().split(/\s+/).length
        extra = `${words} ${words === 1 ? 'word' : 'words'}`
      }
    }
    const started = await this.launch(kind, cliArgvFor(kind, args), subject, stdin, record, side)
    if ('error' in started) return { state: 'error', text: `Plannotator could not start: ${started.error}` }

    const outcome = await this.awaitReady(started, kind === 'review' ? READY_WAIT_MS.review : READY_WAIT_MS.other)
    if (outcome === 'exited') return { state: 'error', text: await this.startupFailure(started) }
    const sessionId = sessionIdOf(started)
    if (outcome === 'timeout') return { state: 'starting', subject, sessionId }
    return { state: 'ready', subject, url: started.url as string, sessionId, ...(extra ? { extra } : {}) }
  }

  // --- Plan review -------------------------------------------------------------

  /** Resolve the plan an ExitPlanMode call carries: the plan file when trustworthy (#1667), else the inline plan. */
  async resolvePlan(input: { plan?: unknown; planFilePath?: unknown }): Promise<string> {
    const inline = typeof input.plan === 'string' ? input.plan : ''
    const path = input.planFilePath
    if (!isTrustablePlanPath(path)) return inline
    try {
      const size = await this.host.fileSize(path)
      if (size === null || size > MAX_PLAN_FILE_BYTES) return inline
      return (await this.host.readFile(path)) || inline
    } catch {
      return inline
    }
  }

  private openPlanReview(): (LiveLaunch & { version: number }) | null {
    for (const launch of this.launches.values()) {
      if (launch.kind === 'plan' && !launch.settling) return launch as LiveLaunch & { version: number }
    }
    return null
  }

  /**
   * The `tool.call` hook on ExitPlanMode. `pass` lets the call through (the
   * approved plan, or a fallback to Claude Code's own flow); otherwise the
   * call is answered with `deny` text Claude reads.
   */
  async onPlanCall(input: { tool_use_id: string; plan?: unknown; planFilePath?: unknown }): Promise<{ pass: true } | { deny: string }> {
    const plan = await this.resolvePlan(input)
    if (!plan.trim()) return { pass: true }
    const hash = await this.host.sha256(normalizePlanForHash(plan))
    const open = this.openPlanReview()
    const openState: OpenPlanReview | null = open
      ? { launchId: open.id, dir: open.dir, version: open.version, revisionSeq: open.revisionSeq ?? 0, url: open.url }
      : null
    const action = planCallAction(hash, { approval: this.approval, open: openState })

    if (action.kind === 'pass-approved') {
      this.passing.set(input.tool_use_id, action.approval)
      this.approval = null
      await this.persistApproval()
      return { pass: true }
    }

    // A different plan than the approved one needs its own review.
    if (this.approval) {
      this.approval = null
      await this.persistApproval()
    }

    if (action.kind === 'revise' && open) return this.revisePlan(open, plan)
    return this.startPlanReview(plan, typeof input.planFilePath === 'string' ? input.planFilePath : undefined)
  }

  private async startPlanReview(plan: string, planFilePath?: string): Promise<{ pass: true } | { deny: string }> {
    if (this.classicPlanReview) return { pass: true }
    const version = this.planVersion + 1
    const subject = subjectFor('plan', '', version)
    const stdin = (dir: string) => JSON.stringify({ plan, planFilePath, revisionFile: fileIn(dir, 'revision') })
    const started = await this.launch('plan', ['plannotator', 'claude-mod-plan'], subject, stdin, { version, revisionSeq: 0 })
    if ('error' in started) {
      // Fall back to Claude Code's own flow (and the classic hook) rather than strand the plan.
      this.host.log(`Could not open the plan review (${started.error}).`)
      return { pass: true }
    }
    this.planVersion = version
    const outcome = await this.awaitReady(started, READY_WAIT_MS.other)
    if (outcome === 'exited') {
      if (await this.lacksModPlan(started)) {
        this.planVersion = version - 1
        await this.fallBackToClassicPlans(started)
        return { pass: true }
      }
      this.host.log(await this.startupFailure(started))
      return { pass: true }
    }
    this.host.toast(planWaitingStatus(version))
    return { deny: waitingDenyText(version, started.url) }
  }

  private async revisePlan(open: LiveLaunch & { version: number }, plan: string): Promise<{ deny: string }> {
    const seq = (open.revisionSeq ?? 0) + 1
    open.revisionSeq = seq
    await this.host.writeFile(fileIn(open.dir, 'revision'), JSON.stringify({ seq, plan }))
    await this.persist()
    const ackPath = `${fileIn(open.dir, 'revision')}.ack`
    const deadline = (await this.host.now()) + REVISION_ACK_WAIT_MS
    while ((await this.host.now()) < deadline) {
      await this.host.waitForAny([ackPath], 250)
      if (await this.host.exists(ackPath)) {
        try {
          const ack = JSON.parse(await this.host.readFile(ackPath)) as { seq?: number; accepted?: boolean; unchanged?: boolean }
          if (ack.seq === seq) {
            if (!ack.accepted) return { deny: decidingDenyText() }
            if (ack.unchanged) return { deny: unchangedDenyText(open.version) }
            const version = this.planVersion + 1
            this.planVersion = version
            open.version = version
            open.subject = subjectFor('plan', '', version)
            await this.persist()
            this.refreshStatus()
            this.host.toast(`Plan v${version} replaced v${version - 1} in the open tab`)
            return { deny: revisedDenyText(version) }
          }
        } catch {
          // An older ack or one being written; look again.
        }
      }
    }
    return { deny: revisionPendingDenyText(open.version) }
  }

  /** `classic.PermissionRequest` for ExitPlanMode: the decision, or null to defer. */
  onPlanPermission(toolUseId: string | undefined, toolInput: unknown): ReturnType<typeof approvedPermissionDecision> | null {
    const approval = toolUseId ? this.passing.get(toolUseId) : undefined
    if (!approval) {
      // The PermissionRequest input may not carry tool_use_id: take the one
      // approved call in flight, if exactly one.
      if (this.passing.size !== 1) return null
      const [only] = this.passing.values()
      return only ? approvedPermissionDecision(toolInput, only) : null
    }
    return approvedPermissionDecision(toolInput, approval)
  }

  /** The approved ExitPlanMode call finished (allowed or not). */
  onPlanCallSettled(toolUseId: string): void {
    this.passing.delete(toolUseId)
  }

  // --- Watching and delivery -------------------------------------------------

  private async tick(): Promise<void> {
    if (this.disposed) return
    for (const launch of [...this.launches.values()]) {
      if (launch.settling || launch.starting) continue
      launch.ticks += 1
      try {
        await this.check(launch)
      } catch {
        // A transient read failure: next tick.
      }
    }
    this.stopTimerIfIdle()
  }

  private async check(launch: LiveLaunch): Promise<void> {
    if (!launch.url) await this.readReady(launch)
    // Started from the timer, never from inside a hook: the loop outlives any one dispatch.
    if (launch.port && !launch.bridge) this.startBridge(launch)
    const resultPath = fileIn(launch.dir, 'result')
    if (launch.closedByAgent) {
      // Only a record marked closedBy "agent" (or an exit with no decision) is
      // Claude's close. A record without it, or an older CLI that exited 0, is
      // the reviewer's decision that won the race against a TERM: deliver it.
      const record = (await this.host.exists(resultPath)) ? parseHostResult(await this.host.readFile(resultPath)) : null
      if (record) {
        if (record.closedBy === 'agent') {
          await this.finishAgentClose(launch, record)
          return
        }
        this.host.debug(`result ${launch.id}: ${record.surface} ${record.decision} after Claude's close; delivering it`)
        launch.closedByAgent = false
        launch.settling = true
        await this.settle(launch, record)
        return
      }
      const exitPath = fileIn(launch.dir, 'exit')
      if (await this.host.exists(exitPath)) {
        const code = (await this.host.readFile(exitPath).catch(() => '')).trim()
        if (code !== '0' || launch.kind === 'plan') {
          await this.finishAgentClose(launch, null)
          return
        }
        // Exit 0 with no record: fall through to the legacy stdout path below.
        launch.closedByAgent = false
      } else {
        if (launch.ticks % PID_CHECK_EVERY_TICKS === 0) await this.checkAlive(launch)
        return
      }
    }
    if (await this.host.exists(resultPath)) {
      const record = parseHostResult(await this.host.readFile(resultPath))
      if (record) {
        this.host.debug(`result ${launch.id}: ${record.surface} ${record.decision}${record.noop ? ' (no-op)' : ''}`)
        launch.settling = true
        await this.settle(launch, record)
        return
      }
    }
    if (await this.host.exists(fileIn(launch.dir, 'exit'))) {
      launch.settling = true
      const code = (await this.host.readFile(fileIn(launch.dir, 'exit')).catch(() => '')).trim()
      // A CLI older than the host result file still prints the decision the
      // skill would have shown Claude. (A plan never exits 0 without a record.)
      if (code === '0' && launch.kind !== 'plan') {
        const printed = (await this.host.readFile(fileIn(launch.dir, 'stdout')).catch(() => '')).trim()
        await this.settle(launch, legacyResult(launch.kind, printed))
        return
      }
      // An old CLI that took longer to refuse claude-mod-plan than the hook
      // waited: Claude was told a review is open and is waiting on nothing.
      if (launch.kind === 'plan' && (await this.lacksModPlan(launch))) {
        await this.fallBackToClassicPlans(launch)
        this.delivering = this.delivering
          .then(() => this.host.submit(`Plannotator: ${launch.subject} — not opened.\n\n${CLASSIC_PLAN_RETRY_TEXT}`))
          .catch(() => undefined)
        await this.delivering
        return
      }
      // Exited without a decision: a crash, a kill, or a startup failure we did not wait for.
      this.host.log(`The review server for ${launch.subject} stopped${code ? ` (exit ${code})` : ''} without a decision. Your draft is saved.`)
      await this.forget(launch)
      return
    }
    if (launch.ticks % PID_CHECK_EVERY_TICKS === 0) await this.checkAlive(launch)
  }

  private async checkAlive(launch: LiveLaunch): Promise<void> {
    const pid = (await this.host.readFile(fileIn(launch.dir, 'pid')).catch(() => '')).trim()
    if (!/^\d+$/.test(pid)) return
    const probe = await this.host.run(aliveArgv(pid), { timeoutMs: 5_000 }).catch(() => null)
    if (!probe) return
    if (probe.exitCode === 0) {
      launch.pidMisses = 0
      return
    }
    launch.pidMisses += 1
    // Gone and never wrote an exit code: the whole process group was killed.
    if (launch.pidMisses >= PID_MISSES_BEFORE_STOPPED && !(await this.host.exists(fileIn(launch.dir, 'exit')))) {
      if (launch.closedByAgent) {
        await this.finishAgentClose(launch, null)
        return
      }
      launch.settling = true
      this.host.log(`The review server for ${launch.subject} is no longer running. Your draft is saved.`)
      await this.forget(launch)
    }
  }

  private async settle(launch: LiveLaunch, record: HostResultRecord): Promise<void> {
    if (record.surface === 'plan' && record.decision === 'approved' && typeof record.approvedPlan === 'string') {
      this.approval = {
        hash: await this.host.sha256(normalizePlanForHash(record.approvedPlan)),
        plan: record.approvedPlan,
        permissionMode: record.permissionMode,
        version: launch.version ?? this.planVersion,
      }
      await this.persistApproval()
    }
    await this.forget(launch)
    const delivery = deliveryFor(record, {
      subject: launch.subject,
      sessionId: sessionIdOf(launch),
      overflowPath: fileIn(launch.dir, 'overflow'),
      deliverApproval: launch.deliverApproval === true,
    })
    // Several decisions are delivered one by one, in the order they arrived.
    this.delivering = this.delivering.then(async () => {
      if (delivery.action === 'log') {
        this.host.log(delivery.text)
        if (delivery.suggest) await this.host.suggest(delivery.suggest).catch(() => undefined)
        return
      }
      if (delivery.overflow) await this.host.writeFile(delivery.overflow.path, delivery.overflow.text)
      this.host.toast(`${launch.subject} — feedback received`)
      await this.host.submit(delivery.text).catch((error: unknown) => {
        this.host.log(`Could not send the ${launch.subject} decision to Claude (${error instanceof Error ? error.message : String(error)}).`)
      })
    }).catch(() => undefined)
    await this.delivering
    // The launch's copies of the plan/message and feedback are not kept once
    // delivered (feedback.md stays: Claude reads it after this turn).
    await this.host.run(cleanupArgv(launch.dir), { timeoutMs: 5_000 }).catch(() => undefined)
  }

  private async forget(launch: LiveLaunch): Promise<void> {
    this.launches.delete(launch.id)
    await this.persist()
    this.refreshStatus()
    this.stopTimerIfIdle()
  }

  // --- Ask this session ------------------------------------------------------

  private startBridge(launch: LiveLaunch): void {
    if (launch.bridge || !launch.port || !launch.bridgeToken) return
    const bridge = createBridge({
      host: this.host,
      baseUrl: bridgeBaseUrl(launch.port),
      token: launch.bridgeToken,
      turns: this.turns,
      isLive: () => !this.disposed && this.launches.get(launch.id) === launch && !launch.settling && !launch.closedByAgent,
    })
    launch.bridge = bridge
    void bridge.run()
  }

  /** A prompt entered the session (prompt.submit), from register.ts. */
  onPromptEntered(prompt: EnteredPrompt): void {
    const { text, fromUs, turnId, originKind } = prompt
    this.host.debug(
      `prompt.submit${fromUs ? ' (ours)' : ''}${originKind ? ` [${originKind}]` : ''}${turnId ? ` into ${turnId}` : ''}: ${JSON.stringify(text.slice(0, 160))}`,
    )
    const wasOurs = !!turnId && this.turns.ownsTurn(turnId)
    this.turns.onPromptEntered(prompt)
    if (wasOurs && turnId && this.turns.isTakenOver(turnId)) this.host.debug(`ask turn ${turnId} taken over`)
  }

  /** A prompt reached prompt.submit, before the hooks beneath it ran, from register.ts. */
  onPromptSubmitting(prompt: Omit<EnteredPrompt, 'text'>): void {
    this.turns.onPromptSubmitting(prompt)
  }

  /** A prompt announced by onPromptSubmitting did not enter, from register.ts. */
  onPromptDropped(prompt: Omit<EnteredPrompt, 'text'>): void {
    this.turns.onPromptDropped(prompt)
  }

  /** A model request of a turn is about to go out (turn.step), from register.ts. */
  onTurnStep(turnId: string): void {
    this.turns.onStep(turnId)
  }

  /** A model response of a turn finished (turn.step's `stop` chunk), from register.ts. */
  onTurnStepStop(turnId: string, stopReason: string | null): void {
    this.turns.onStepStop(turnId, stopReason)
  }

  /** Turn events, from register.ts. */
  async onTurnStart(turnId: string, text: string): Promise<void> {
    this.host.debug(`turn.start ${turnId}: ${JSON.stringify(text.slice(0, 160))}`)
    const drop = this.turns.onTurnStart(turnId, text)
    if (drop) await this.host.abortTurn(drop).catch(() => undefined)
    this.pushBridgeStatus()
  }

  onTurnComplete(turnId: string, answer: string, aborted: boolean): void {
    this.host.debug(`turn.complete ${turnId}${aborted ? ' (aborted)' : ''}: ${answer.length} chars`)
    this.turns.onTurnComplete(turnId, answer, aborted)
    this.pushBridgeStatus()
  }

  private pushBridgeStatus(): void {
    for (const launch of this.launches.values()) launch.bridge?.pushStatus()
  }

  // --- Status line ---------------------------------------------------------------

  private refreshStatus(): void {
    const open = this.openLaunches()
    if (open.length === 0) {
      this.host.status(undefined)
      return
    }
    if (open.length === 1) {
      const [only] = open
      const state = !only?.url ? 'starting review server…' : only.kind === 'plan' ? 'waiting for your review' : 'waiting for you'
      this.host.status(`${only?.subject} · ${state}`)
      return
    }
    this.host.status(`${open.length} open · ${open.map((launch) => launch.subject).join(' · ')}`)
  }
}
