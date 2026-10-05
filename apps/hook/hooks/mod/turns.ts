/**
 * The session's turns as the mod sees them (`turn.start` / `turn.step` /
 * `turn.complete`), and the one "Ask this session" question that may be
 * running as a turn of its own.
 *
 * A question is submitted with `$.prompt.submit`, which waits for the session
 * to be idle; the turn that starts with its text is the question's turn. Its
 * streamed text goes back to Plannotator as deltas and its final answer as
 * `done`. A question cancelled while still queued is confirmed at once and its
 * turn is aborted the moment it starts.
 *
 * Take-over: a prompt someone else put into the question's turn while it ran
 * (`prompt.submit` carrying that turn's id: the person typing, a peer, a
 * channel; never a background task's notification, which is the agent's own
 * work) makes the rest of the turn theirs. From that moment nothing more is
 * streamed. The step in flight was requested before their prompt existed, so
 * what it says is still the question's answer: it is held and released when
 * the ask settles. The ask settles at the turn's next step (the engine folds a
 * prompt typed mid-turn into the next model request, so from there on the
 * output answers THEM) with `taken_over` and the note below, or, when the turn
 * ends first (their prompt then runs as a turn of its own), with the turn's
 * answer as `done`. Either way Plannotator never aborts that turn again: a
 * Stop only closes the question, and "Interrupt and ask now" refuses.
 */

export interface AskSink {
  delta(text: string): void
  tool(name: string): void
  done(answer: string): void
  error(code: AskErrorCode, message?: string): void
}

export type AskErrorCode = 'busy' | 'blocked' | 'gone' | 'aborted' | 'failed' | 'taken_over'

/**
 * Sent with `taken_over`, so a server older than that code (it reads an
 * unknown code as `failed`) still shows why the answer stopped. Same text as
 * `SESSION_ASK_TAKEN_OVER_TEXT` in packages/ai/session-bridge.ts (a hooks
 * module imports only its own files).
 */
export const TAKEN_OVER_TEXT =
  'You typed into this session while it was answering, so the rest of the reply went to your prompt.'

/** What `prompt.submit` reported for a prompt that entered the session. */
export interface EnteredPrompt {
  text: string
  /** Its origin is this plugin. */
  fromUs: boolean
  /** The turn it was typed over or delivered into (`e.turnId`); absent when the session was idle. */
  turnId?: string
  /** `origin.kind` (`composer`, `task-notification`, `plugin`, ...). */
  originKind?: string
}

/** Origins whose prompt delivered into a running turn is that turn's own work, not a take-over. */
const OWN_WORK_ORIGINS: ReadonlySet<string> = new Set(['task-notification'])

interface ActiveAsk {
  askId: string
  text: string
  sink: AskSink
  turnId: string | null
  cancelled: boolean
  finished: boolean
  /** Someone else's prompt entered this turn: nothing more is streamed. */
  takenOver: boolean
  /** Output of the step in flight at the take-over, released when the ask settles. */
  held: { kind: 'text' | 'tool'; value: string }[]
}

export class TurnTracker {
  /** The main-loop turn running now, if any. */
  runningTurnId: string | null = null
  private ask: ActiveAsk | null = null
  /** A question cancelled while still queued: its turn is aborted when it starts. */
  private dropText: string | null = null
  /**
   * Prompts that entered the session from anyone but this plugin (the user's
   * Enter, a notification, another plugin), as `prompt.submit` saw them. The
   * engine never raises our own hooks for a prompt our code submitted, so the
   * hook only ever reports these; and when it does see one of ours (origin
   * plugin `plannotator`) it is not recorded. A turn whose text IS one of these
   * prompts is that prompt's turn, never the question's, whatever it says: a
   * prompt the user typed can neither be streamed to Plannotator nor aborted
   * by a cancel.
   */
  private foreign: string[] = []
  /** Turns that started as a question's and were taken over: Plannotator never aborts them. */
  private takenOverTurns = new Set<string>()

  /** A prompt entered (prompt.submit). */
  onPromptEntered(prompt: EnteredPrompt): void {
    if (prompt.fromUs) return
    const value = prompt.text.trim()
    if (value) {
      this.foreign.push(value)
      if (this.foreign.length > 16) this.foreign.shift()
    }
    if (prompt.turnId && !(prompt.originKind && OWN_WORK_ORIGINS.has(prompt.originKind))) this.takeOver(prompt.turnId)
  }

  /** Someone else's prompt entered `turnId`: if it is the question's, stop streaming it. */
  private takeOver(turnId: string): void {
    const ask = this.ask
    if (!ask || ask.finished || ask.turnId !== turnId || ask.takenOver) return
    ask.takenOver = true
    this.takenOverTurns.add(turnId)
  }

  /** Whether the turn is a prompt someone else submitted (consumed). */
  private takeForeign(turnText: string): boolean {
    const value = turnText.trim()
    // Another plugin's prompt reaches turn.start inside the engine's frame
    // ("The <name> plugin sent a message: ..."), while prompt.submit saw it bare.
    const unframed = value.replace(PLUGIN_FRAME, '').trim()
    let index = this.foreign.lastIndexOf(value)
    if (index < 0 && unframed !== value) index = this.foreign.lastIndexOf(unframed)
    if (index < 0) return false
    this.foreign.splice(index, 1)
    return true
  }

  /** Whether a turn started as a question's and is now someone else's. */
  isTakenOver(turnId: string): boolean {
    return this.takenOverTurns.has(turnId)
  }

  get busy(): boolean {
    return this.runningTurnId !== null || (this.ask !== null && !this.ask.finished)
  }

  get askInFlight(): boolean {
    return this.ask !== null && !this.ask.finished
  }

  /** Register a question about to be submitted. False when one is already in flight. */
  beginAsk(askId: string, text: string, sink: AskSink): boolean {
    if (this.askInFlight) return false
    this.ask = { askId, text, sink, turnId: null, cancelled: false, finished: false, takenOver: false, held: [] }
    return true
  }

  isActiveAsk(askId: string): boolean {
    return this.ask?.askId === askId && !this.ask.finished
  }

  /** A turn started. Returns the turn to abort at once (a cancelled question's). */
  onTurnStart(turnId: string, text: string): string | null {
    this.runningTurnId = turnId
    if (this.takeForeign(text)) return null
    if (this.dropText !== null && sameQuestion(text, this.dropText)) {
      this.dropText = null
      return turnId
    }
    const ask = this.ask
    if (ask && !ask.finished && ask.turnId === null && sameQuestion(text, ask.text)) {
      ask.turnId = turnId
    }
    return null
  }

  ownsTurn(turnId: string): boolean {
    return !!this.ask && !this.ask.finished && this.ask.turnId === turnId
  }

  onText(turnId: string, text: string): void {
    const ask = this.ask
    if (!ask || !this.ownsTurn(turnId) || !text) return
    if (ask.takenOver) ask.held.push({ kind: 'text', value: text })
    else ask.sink.delta(text)
  }

  onTool(turnId: string, name: string): void {
    const ask = this.ask
    if (!ask || !this.ownsTurn(turnId) || !name) return
    if (ask.takenOver) ask.held.push({ kind: 'tool', value: name })
    else ask.sink.tool(name)
  }

  /**
   * A model request of `turnId` is about to go out (turn.step). After a
   * take-over it carries the other prompt, so the question settles here.
   */
  onStep(turnId: string): void {
    const ask = this.ask
    if (!ask || ask.finished || ask.turnId !== turnId || !ask.takenOver) return
    ask.finished = true
    this.releaseHeld(ask)
    ask.sink.error('taken_over', TAKEN_OVER_TEXT)
  }

  onTurnComplete(turnId: string, answer: string, aborted: boolean): void {
    if (this.runningTurnId === turnId) this.runningTurnId = null
    this.takenOverTurns.delete(turnId)
    const ask = this.ask
    if (!ask || ask.finished || ask.turnId !== turnId) return
    ask.finished = true
    if (ask.takenOver) {
      // No step ran after the other prompt entered: everything the turn said
      // answered the question (their prompt runs as a turn of its own).
      this.releaseHeld(ask)
      if (aborted || !answer.trim()) ask.sink.error('taken_over', TAKEN_OVER_TEXT)
      else ask.sink.done(answer)
      return
    }
    if (aborted || ask.cancelled) ask.sink.error('aborted')
    else if (answer.trim()) ask.sink.done(answer)
    else ask.sink.error('failed', 'Claude finished the turn without a text answer.')
  }

  private releaseHeld(ask: ActiveAsk): void {
    for (const item of ask.held) {
      if (item.kind === 'text') ask.sink.delta(item.value)
      else ask.sink.tool(item.value)
    }
    ask.held = []
  }

  /**
   * Cancel OUR question. Returns the turn id to abort when its turn is
   * running; a question still queued is dropped when its turn starts.
   */
  cancelAsk(askId: string): string | null {
    const ask = this.ask
    if (!ask || ask.askId !== askId || ask.finished) return null
    ask.cancelled = true
    if (ask.takenOver) {
      // The turn carries someone else's prompt now: close the question, never the turn.
      ask.finished = true
      ask.held = []
      ask.sink.error('aborted')
      return null
    }
    if (ask.turnId) return ask.turnId
    // Still queued behind another turn: confirm now, abort its turn when it starts.
    ask.finished = true
    this.dropText = ask.text
    ask.sink.error('aborted')
    return null
  }

  /** The submit failed: the question never reached the session. */
  failAsk(askId: string, message: string): void {
    const ask = this.ask
    if (!ask || ask.askId !== askId || ask.finished) return
    ask.finished = true
    ask.sink.error('failed', message)
  }
}

/** The engine's frame around a plugin's prompt at turn.start. */
const PLUGIN_FRAME = /^The [^\n]{1,200}? plugin sent a message:\s*/

/**
 * Whether a turn's text is our question. The engine may wrap a plugin's
 * prompt in a "sent a message" frame, expand pastes or trim, so the question's
 * first and last lines are what identify it.
 */
export function sameQuestion(turnText: string, askText: string): boolean {
  const turn = turnText.trim()
  const ask = askText.trim()
  if (!ask) return false
  if (turn.includes(ask)) return true
  const firstLine = ask.split('\n', 1)[0] ?? ''
  const lastLine = ask.slice(ask.lastIndexOf('\n') + 1)
  return firstLine.length > 0 && turn.includes(firstLine) && turn.includes(lastLine)
}
