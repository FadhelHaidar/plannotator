/**
 * The `plannotator` agent tool on OpenCode 2 (contract:
 * `packages/shared/plannotator-tool.ts`, the same one the Claude Code mod
 * registers), plus the record of the reviews each OpenCode session opened.
 *
 * Open actions (annotate, review, last) go through the SAME launch the native
 * slash commands use (`runNativeCommand` -> `handleCliCommand`: a `plannotator`
 * CLI child, the pull-bridge token for "Ask this session", the ready file, the
 * decision delivered later to the session with `session.prompt`). The tool
 * returns as soon as the server is up, with the session id and the url, while
 * the child keeps running in the background.
 *
 * `list` and `close` see only the reviews THIS OpenCode session opened (tool
 * calls, its slash commands, and its plan review), from the plugin's own
 * record: never the global `sessions/` registry. Closing calls the CLI's
 * host-only `POST /api/host/close` with the launch's token (the reviewer's
 * Close, draft kept, the tab told). Only a server that answered as an older
 * Plannotator without the endpoint is stopped instead, with SIGTERM to the
 * plugin's own child process; a server that does not answer, refuses, or runs
 * in remote mode is left running.
 *
 * Plan review is not part of the tool: it stays on `submit_plan`.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ParsedAnnotateArgs } from "@plannotator/shared/annotate-args";
import {
  HOST_CLOSE_PATH,
  HOST_STATUS_PATH,
  classifyHostCloseAnswer,
  readHostStatusAnswer,
  type HostHttpAnswer,
} from "@plannotator/shared/host-control";
import {
  PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
  PLANNOTATOR_TOOL_REPLY_UNAVAILABLE_TEXT,
  parsePlannotatorToolInput,
  plannotatorSessionId,
  plannotatorToolArgs,
  plannotatorToolCloseText,
  plannotatorToolListText,
  plannotatorToolOpenedText,
  plannotatorToolTargets,
  plannotatorUnknownSessionText,
  type PlannotatorCloseOutcome,
  type PlannotatorSessionSummary,
  type PlannotatorToolInput,
} from "@plannotator/shared/plannotator-tool";
import type { CliLaunch } from "./cli-bridge";

export type LaunchKind = "plan" | "annotate" | "review" | "last";

/** One review an OpenCode session opened, while it is open. */
export interface TrackedLaunch {
  /** `pn-` + 6 hex. */
  readonly id: string;
  /** The OpenCode session that opened it; `list` and `close` filter on it. */
  readonly owner: string;
  readonly kind: LaunchKind;
  readonly subject: string;
  readonly startedAt: number;
  url?: string;
  port?: number;
  isRemote?: boolean;
  /** The host-control token the CLI child was started with (its pull-bridge token). */
  token?: string;
  /** SIGTERM the plugin's own child; the older-CLI close fallback only. */
  terminate?: () => boolean;
  closedByAgent: boolean;
}

/** How a launch's start went, as the tool waits for it. */
export type LaunchStart =
  | { state: "ready"; url: string }
  | { state: "failed"; message: string }
  /** The command ended without opening a page and without saying why. */
  | { state: "ended" };

export interface LaunchHandle {
  readonly launch: TrackedLaunch;
  /** Hand this to `handleCliCommand` (or a plan review's ready hook). */
  readonly observer: CliLaunch;
  /** Settles once: the server is up, the command failed, or it ended. */
  readonly started: Promise<LaunchStart>;
  /** The command is over (decision delivered or not, or failed): forget the launch. */
  end(): void;
}

/**
 * The plugin's record of open reviews, keyed by session id. One per plugin
 * instance; entries live from launch to the end of the command.
 */
export class OpenCodeLaunchRegistry {
  private readonly launches = new Map<string, TrackedLaunch>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly randomHex: () => string = () => randomBytes(3).toString("hex"),
  ) {}

  /** A fresh `pn-` id, unique among the open launches of every session. */
  private nextId(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = plannotatorSessionId(this.randomHex());
      if (!this.launches.has(id)) return id;
    }
    throw new Error("Could not allocate a Plannotator session id.");
  }

  begin(owner: string, kind: LaunchKind, subject: string, options: { deliverApproval?: boolean } = {}): LaunchHandle {
    const launch: TrackedLaunch = {
      id: this.nextId(),
      owner,
      kind,
      subject,
      startedAt: this.now(),
      closedByAgent: false,
    };
    this.launches.set(launch.id, launch);

    let settle!: (start: LaunchStart) => void;
    let settled = false;
    const started = new Promise<LaunchStart>((resolve) => {
      settle = (start) => {
        if (settled) return;
        settled = true;
        resolve(start);
      };
    });

    const observer: CliLaunch = {
      sessionId: launch.id,
      subject,
      ...(options.deliverApproval ? { deliverApproval: true } : {}),
      onSpawn: ({ token, terminate }) => {
        launch.token = token;
        launch.terminate = terminate;
      },
      onServer: ({ url, port, isRemote }) => {
        launch.url = url;
        launch.port = port ?? portFromUrl(url);
        launch.isRemote = isRemote;
        settle({ state: "ready", url });
      },
      onFailure: (message) => settle({ state: "failed", message }),
    };

    return {
      launch,
      observer,
      started,
      end: () => {
        this.launches.delete(launch.id);
        settle({ state: "ended" });
      },
    };
  }

  /** The reviews `owner` opened that are still open (not ended, not closed by the agent). */
  openFor(owner: string): TrackedLaunch[] {
    return [...this.launches.values()].filter((launch) => launch.owner === owner && !launch.closedByAgent);
  }
}

/** The port of a loopback url, for a CLI whose ready file carries none. */
function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return undefined;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function baseName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
}

const PR_URL = /^https?:\/\/[^\s/]+\/.+\/(?:pull|pull-requests|merge_requests)\/(\d+)\b/i;

/** What a review shows, from its target words (directory or PR URL). */
function reviewSubject(words: readonly string[]): string {
  for (const word of words) {
    const match = PR_URL.exec(word);
    if (match) return /merge_requests/i.test(word) ? `MR !${match[1]}` : `PR #${match[1]}`;
  }
  const directory = words[words.length - 1];
  return directory ? `changes in ${baseName(directory)}` : "local changes";
}

/** What an annotate session shows, from its target words. */
function annotateSubject(words: readonly string[]): string {
  const target = words.find((word) => /^https?:\/\//i.test(word) || /[./\\]/.test(word)) ?? words[0];
  if (!target) return "document";
  if (/^https?:\/\//i.test(target)) {
    try {
      return new URL(target).host;
    } catch {
      return target;
    }
  }
  return baseName(target.replace(/^@/, ""));
}

const LAST_SUBJECT = "your last message";

/** The subject a slash command's launch is listed and headed under. */
export function commandSubject(command: string, rawArgs: string): { kind: LaunchKind; subject: string } | null {
  const words = rawArgs.trim().split(/\s+/).filter((word) => word && !word.startsWith("-"));
  switch (command) {
    case "plannotator-annotate":
      return { kind: "annotate", subject: annotateSubject(words) };
    case "plannotator-review": {
      // `--base <ref>` / `--diff-type <id>` take a value that is not a target.
      const all = rawArgs.trim().split(/\s+/).filter(Boolean);
      const targets: string[] = [];
      for (let index = 0; index < all.length; index++) {
        const word = all[index] as string;
        if (word === "--base" || word === "--diff-type") {
          index++;
          continue;
        }
        if (!word.startsWith("-")) targets.push(word);
      }
      return { kind: "review", subject: reviewSubject(targets) };
    }
    case "plannotator-last":
      return { kind: "last", subject: LAST_SUBJECT };
    default:
      return null;
  }
}

/** The subject of a tool call's launch. */
export function toolSubject(call: PlannotatorToolInput): string {
  const targets = plannotatorToolTargets(call);
  switch (call.action) {
    case "annotate":
      return annotateSubject(targets);
    case "review":
      return reviewSubject(targets);
    default:
      return LAST_SUBJECT;
  }
}

/**
 * One word for `parseReviewArgs`'s string form, which splits on whitespace and
 * strips one pair of wrapping quotes (no escapes). The tool's words carry no
 * control characters (the contract refuses them); a word holding both quote
 * kinds and whitespace cannot be written and is refused.
 */
export function quoteReviewWord(word: string): string | null {
  if (!/[\s"']/.test(word)) return word;
  if (!word.includes('"')) return `"${word}"`;
  if (!word.includes("'")) return `'${word}'`;
  return null;
}

/** The arguments one tool call's launch runs with. */
export function toolLaunchRequest(call: PlannotatorToolInput):
  | { ok: true; command: string; rawArgs: string; annotateArgs?: ParsedAnnotateArgs }
  | { ok: false; error: string } {
  switch (call.action) {
    case "annotate": {
      const target = plannotatorToolTargets(call)[0] as string;
      return {
        ok: true,
        command: "plannotator-annotate",
        rawArgs: target,
        // One argument whatever it holds: never re-split.
        annotateArgs: {
          filePath: target.replace(/^@/, ""),
          rawFilePath: target,
          gate: call.gate === true,
          json: false,
          hook: false,
          renderHtml: false,
          renderMarkdown: call.options?.markdown === true,
          noJina: false,
          app: false,
          static: false,
        },
      };
    }
    case "review": {
      const words: string[] = [];
      for (const word of plannotatorToolArgs(call)) {
        const quoted = quoteReviewWord(word);
        if (quoted === null) {
          return { ok: false, error: `Invalid plannotator call: "${word}" holds both kinds of quote and a space, which cannot be passed on.` };
        }
        words.push(quoted);
      }
      return { ok: true, command: "plannotator-review", rawArgs: words.join(" ") };
    }
    default:
      return { ok: true, command: "plannotator-last", rawArgs: "" };
  }
}

/** What a subagent's open action answers: its session ends before any decision could land. */
export const PLANNOTATOR_TOOL_SUBAGENT_TEXT =
  "Plannotator did not open: a review opened from a subagent would deliver its feedback to the subagent's session after it has finished. Tell the main agent which file or changes to open in Plannotator instead.";

export interface PlannotatorToolDeps {
  registry: OpenCodeLaunchRegistry;
  /**
   * Run one tracked launch the way the slash command does (CLI child, pull
   * bridge, decision delivered later). Resolves when the command is over,
   * which is long after the tool has returned.
   */
  launch: (request: {
    sessionID: string;
    command: string;
    rawArgs: string;
    annotateArgs?: ParsedAnnotateArgs;
    launch: CliLaunch;
  }) => Promise<void>;
  /** True for a subagent's (child) session. Absent: never. */
  isSubagentSession?: (sessionID: string) => Promise<boolean>;
  /** HTTP to the CLI's own server (tests replace it). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** How long the tool waits for the page before answering "starting". */
  readyWaitMs?: { review: number; other: number };
  now?: () => number;
}

/** Same waits as the Claude Code mod: a review prepares a diff, the rest open fast. */
const READY_WAIT_MS = { review: 45_000, other: 15_000 };
const HOST_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Answer one `plannotator` tool call from the OpenCode session `sessionID`.
 * Always resolves with the text the model reads (an invalid call, a refusal
 * and a startup error included).
 */
export async function runPlannotatorTool(
  input: unknown,
  context: { sessionID: string },
  deps: PlannotatorToolDeps,
): Promise<string> {
  const parsed = parsePlannotatorToolInput(input);
  if (!parsed.ok) return parsed.error;
  const call = parsed.input;
  switch (call.action) {
    case "list":
      return await listText(context.sessionID, deps);
    case "close":
      return await closeText(context.sessionID, call.session as string, deps);
    case "reply":
      // Reserved for live comments: no comment is ever delivered yet.
      return PLANNOTATOR_TOOL_REPLY_UNAVAILABLE_TEXT;
    case "annotate":
    case "review":
    case "last":
      break;
  }

  // Several files as one review need a CLI with bundles; none has them yet.
  if (Array.isArray(call.target)) return PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT;

  try {
    if (await deps.isSubagentSession?.(context.sessionID)) return PLANNOTATOR_TOOL_SUBAGENT_TEXT;
  } catch {
    // Unknown: treat as the main session, like the slash commands do.
  }

  const request = toolLaunchRequest(call);
  if (!request.ok) return request.error;

  const gate = call.gate === true;
  const subject = toolSubject(call);
  const handle = deps.registry.begin(context.sessionID, call.action, subject, { deliverApproval: gate });
  void deps
    .launch({
      sessionID: context.sessionID,
      command: request.command,
      rawArgs: request.rawArgs,
      ...(request.annotateArgs ? { annotateArgs: request.annotateArgs } : {}),
      launch: handle.observer,
    })
    .catch((error) => {
      handle.observer.onFailure?.(error instanceof Error ? error.message : String(error));
    })
    .finally(() => handle.end());

  const waits = deps.readyWaitMs ?? READY_WAIT_MS;
  const waitMs = call.action === "review" ? waits.review : waits.other;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  const start = await Promise.race([handle.started, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (start === "timeout") return plannotatorToolOpenedText(subject, undefined, gate, handle.launch.id);
  switch (start.state) {
    case "ready":
      return plannotatorToolOpenedText(subject, start.url, gate, handle.launch.id);
    case "failed":
      return `Plannotator could not start: ${start.message}`;
    case "ended":
      return "Plannotator could not start: it exited before opening the page.";
  }
}

async function hostRequest(
  launch: TrackedLaunch,
  pathname: string,
  init: RequestInit,
  deps: PlannotatorToolDeps,
): Promise<HostHttpAnswer | null> {
  if (!launch.port) return null;
  const doFetch = deps.fetch ?? ((url: string, options: RequestInit) => fetch(url, options));
  try {
    const response = await doFetch(`http://127.0.0.1:${launch.port}${pathname}`, {
      ...init,
      // No Origin header: the server refuses browser requests here.
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${launch.token ?? ""}` },
      signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}

async function listText(sessionID: string, deps: PlannotatorToolDeps): Promise<string> {
  const now = (deps.now ?? (() => Date.now()))();
  const sessions: PlannotatorSessionSummary[] = [];
  for (const launch of deps.registry.openFor(sessionID)) {
    const status = launch.url ? readHostStatusAnswer(await hostRequest(launch, HOST_STATUS_PATH, { method: "GET" }, deps)) : null;
    sessions.push({
      id: launch.id,
      kind: launch.kind,
      subject: launch.subject,
      ...(launch.url ? { url: launch.url } : {}),
      ageMs: now - launch.startedAt,
      state: !launch.url ? "starting" : status?.decided ? "decided" : "open",
      unsent: status ? status.unsent : null,
    });
  }
  return plannotatorToolListText(sessions);
}

async function closeText(sessionID: string, session: string, deps: PlannotatorToolDeps): Promise<string> {
  const open = deps.registry.openFor(sessionID);
  if (session === "all") {
    const outcomes: PlannotatorCloseOutcome[] = [];
    for (const launch of open) outcomes.push(await closeLaunch(launch, deps));
    return plannotatorToolCloseText(outcomes);
  }
  const launch = open.find((candidate) => candidate.id === session);
  if (!launch) return plannotatorUnknownSessionText(session);
  return plannotatorToolCloseText([await closeLaunch(launch, deps)]);
}

/**
 * Close one review: the server's host close (the reviewer's Close, draft
 * kept, the tab told). Only a server that answered as an older Plannotator
 * without the endpoint is stopped instead (SIGTERM to the plugin's own child,
 * which never deletes a draft). Plan reviews end only with a decision.
 */
async function closeLaunch(launch: TrackedLaunch, deps: PlannotatorToolDeps): Promise<PlannotatorCloseOutcome> {
  const { id, subject } = launch;
  if (launch.kind === "plan") return { id, subject, closed: false, reason: "plan" };
  if (!launch.port) {
    return { id, subject, closed: false, reason: "failed", detail: "its server has not started yet; try again in a moment" };
  }
  const answer = classifyHostCloseAnswer(
    await hostRequest(launch, HOST_CLOSE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, deps),
  );
  switch (answer.kind) {
    case "closed":
      launch.closedByAgent = true;
      return { id, subject, closed: true, unsent: answer.unsent };
    case "decided":
      return { id, subject, closed: false, reason: "decided" };
    case "unreachable":
      // Nothing answers on its port: never signal on a guess.
      return { id, subject, closed: false, reason: "failed", detail: "its server is not answering" };
    case "refused":
      return { id, subject, closed: false, reason: "failed", detail: `its server refused the close (HTTP ${answer.status})` };
    case "disabled":
      return {
        id,
        subject,
        closed: false,
        reason: "failed",
        detail: "it runs in remote mode, where Plannotator turns host close off; close it from the tab",
      };
    case "older": {
      // Proven an older Plannotator on the port of our own live child: stop
      // that child. A decision such a CLI is still publishing (it waits 1.5 s
      // after the reviewer decides) is lost; see "Version skew" in AGENTS.md.
      if (launch.terminate?.()) {
        launch.closedByAgent = true;
        return { id, subject, closed: true, unsent: null };
      }
      return { id, subject, closed: false, reason: "failed", detail: "its server process is gone" };
    }
  }
}
