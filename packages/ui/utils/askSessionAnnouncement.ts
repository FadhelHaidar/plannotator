/**
 * One-time gate for the "Ask this session" announcement: Ask AI answered by
 * the agent session that opened Plannotator, and reviews that no longer hold
 * that session. Cookie-backed like the other announcement gates, so a
 * dismissal survives Plannotator's random localhost ports, and shared by the
 * plan editor, the annotate surfaces and the code review editor: dismissing it
 * anywhere retires it everywhere.
 *
 * A plain storage key rather than a settings-registry entry for the same reason
 * as terminalToolsAnnouncement.ts: configStore seeds every registry default
 * into a cookie on first access, so a registry flag could not tell "never seen"
 * from "seeded default".
 */

import type { Origin } from '@plannotator/core/agents';
import { storage } from './storage';
import { needsTerminalToolsAnnouncement } from './terminalToolsAnnouncement';

const STORAGE_KEY = 'plannotator-announce-ask-session-seen';
// Bump to re-announce after a meaningful revision.
const CURRENT_VERSION = '1';

export function needsAskSessionAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markAskSessionAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

/**
 * Whether this page load may show the announcement, latched at mount by the
 * Apps. False while the terminal-tools announcement is still pending: that one
 * takes this load, and this one waits for the next, so a reader never gets two
 * announcements back to back. A reader who dismissed the terminal-tools
 * announcement on an earlier load gets this one on the next load.
 */
export function askSessionAnnouncementPendingThisLoad(): boolean {
  return needsAskSessionAnnouncement() && !needsTerminalToolsAnnouncement();
}

/** The hosts whose sessions can answer Ask AI and take decisions as messages. */
export type AskSessionAgent = 'claude-code' | 'pi' | 'opencode';

export function askSessionAgentForOrigin(origin: Origin | null | undefined): AskSessionAgent | null {
  return origin === 'claude-code' || origin === 'pi' || origin === 'opencode' ? origin : null;
}

export interface AskSessionAnnouncementGateState {
  /** Latched at mount from askSessionAnnouncementPendingThisLoad(). */
  readonly announcementPending: boolean;
  /** The app has not finished loading its initial payload. */
  readonly isLoading: boolean;
  /**
   * The agent that opened this session (`/api/plan` / `/api/diff` origin).
   * Only Claude Code, Pi and OpenCode have the feature; any other origin never
   * sees the announcement and never consumes the cookie.
   */
  readonly origin: Origin | null | undefined;
  /**
   * The server answered /api/ai/capabilities with Ask AI available. False
   * while that answer is pending and when Ask AI is turned off
   * (PLANNOTATOR_AI=disabled): an announcement about Ask AI is noise to someone
   * who switched it off, and the cookie is kept for a session that has it.
   */
  readonly aiAvailable: boolean;
  /** Archive browsing, a read-only shared plan, or no Plannotator server. Deferred, not consumed. */
  readonly readOnlySession: boolean;
  /** Plannotator's compact touch shell. Deferred, not consumed. */
  readonly compact: boolean;
  /** Any other first-run dialog is on screen. The chain dialogs never stack. */
  readonly otherFirstRunDialogVisible: boolean;
}

/**
 * Chain gate. LAST in each app's first-run chain, after the terminal-tools
 * announcement (see askSessionAnnouncementPendingThisLoad) and behind every
 * dialog that asks the user to decide something, for the reasons
 * terminalToolsAnnouncementCanShow gives.
 */
export function askSessionAnnouncementCanShow(state: AskSessionAnnouncementGateState): boolean {
  return (
    state.announcementPending &&
    !state.isLoading &&
    askSessionAgentForOrigin(state.origin) !== null &&
    state.aiAvailable &&
    !state.readOnlySession &&
    !state.compact &&
    !state.otherFirstRunDialogVisible
  );
}
