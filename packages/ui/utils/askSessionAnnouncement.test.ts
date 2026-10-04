import { afterEach, describe, expect, test } from 'bun:test';
import {
  askSessionAgentForOrigin,
  askSessionAnnouncementCanShow,
  askSessionAnnouncementPendingThisLoad,
  markAskSessionAnnouncementSeen,
  needsAskSessionAnnouncement,
  type AskSessionAnnouncementGateState,
} from './askSessionAnnouncement';
import { markTerminalToolsAnnouncementSeen } from './terminalToolsAnnouncement';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from './storage';

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function showable(overrides: Partial<AskSessionAnnouncementGateState> = {}) {
  return askSessionAnnouncementCanShow({
    announcementPending: true,
    isLoading: false,
    origin: 'claude-code',
    aiAvailable: true,
    readOnlySession: false,
    compact: false,
    otherFirstRunDialogVisible: false,
    ...overrides,
  });
}

afterEach(() => {
  memory.clear();
  resetStorageBackend();
});

describe('Ask this session announcement gate', () => {
  test('marking it seen is what retires it, and reading writes nothing', () => {
    setStorageBackend(memoryBackend);

    expect(needsAskSessionAnnouncement()).toBe(true);
    expect(memory.size).toBe(0);

    markAskSessionAnnouncementSeen();
    expect(needsAskSessionAnnouncement()).toBe(false);
    // Its own key: dismissing it must not retire the terminal-tools one.
    expect(memory.has('plannotator-announce-tui-herdr-seen')).toBe(false);
  });

  test('a value from another announcement version does not count as seen', () => {
    setStorageBackend(memoryBackend);
    memory.set('plannotator-announce-ask-session-seen', 'true');
    expect(needsAskSessionAnnouncement()).toBe(true);
  });

  test('never on the same load as a pending terminal-tools announcement', () => {
    setStorageBackend(memoryBackend);

    // A fresh browser: the terminal-tools announcement takes this load.
    expect(askSessionAnnouncementPendingThisLoad()).toBe(false);

    // Once that one is dismissed (an earlier load), this one is next.
    markTerminalToolsAnnouncementSeen();
    expect(askSessionAnnouncementPendingThisLoad()).toBe(true);

    markAskSessionAnnouncementSeen();
    expect(askSessionAnnouncementPendingThisLoad()).toBe(false);
  });

  test('only the hosts that have the feature are addressed', () => {
    expect(askSessionAgentForOrigin('claude-code')).toBe('claude-code');
    expect(askSessionAgentForOrigin('pi')).toBe('pi');
    expect(askSessionAgentForOrigin('opencode')).toBe('opencode');
    for (const origin of ['codex', 'amp', 'droid', 'copilot-cli', 'gemini-cli', 'kiro-cli', 'mistral-vibe', 'oh-my-pi'] as const) {
      expect(askSessionAgentForOrigin(origin)).toBeNull();
      expect(showable({ origin })).toBe(false);
    }
    expect(showable({ origin: null })).toBe(false);
    expect(showable({ origin: 'pi' })).toBe(true);
    expect(showable({ origin: 'opencode' })).toBe(true);
  });

  test('every suppressing condition independently withholds the dialog', () => {
    expect(showable()).toBe(true);
    expect(showable({ announcementPending: false })).toBe(false);
    expect(showable({ isLoading: true })).toBe(false);
    expect(showable({ aiAvailable: false })).toBe(false);
    expect(showable({ readOnlySession: true })).toBe(false);
    expect(showable({ compact: true })).toBe(false);
    expect(showable({ otherFirstRunDialogVisible: true })).toBe(false);
  });
});
