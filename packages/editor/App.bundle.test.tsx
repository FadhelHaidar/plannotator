/**
 * A review of several files (annotate-bundle) in the editor: the first file
 * opens by itself, the switcher and the file list follow the given order
 * (never sorted), Next moves to the following file, and one Send Feedback
 * carries one section per file in bundle order with each comment once.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

const hasDom = typeof document !== "undefined";

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
}

class SilentEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = SilentEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

const ROOT = "/tmp/bundle-review";
// Given in this order on purpose: sorted by name, alpha would come first.
const BETA = `${ROOT}/docs/beta.md`;
const ALPHA = `${ROOT}/alpha.md`;
const TEXT: Record<string, string> = {
  [BETA]: "# Beta\n\nBeta body text.\n",
  [ALPHA]: "# Alpha\n\nAlpha body text.\n",
};

/** A saved comment on each file, merged in when the file opens. */
const savedComment = (path: string) => ({
  id: `saved-${path.endsWith("beta.md") ? "beta" : "alpha"}`,
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text: path.endsWith("beta.md") ? "BETA_COMMENT_SENTINEL" : "ALPHA_COMMENT_SENTINEL",
  originalText: path.endsWith("beta.md") ? "Beta" : "Alpha",
  createdA: 1,
});

interface Recorded { method: string; path: string; search: URLSearchParams; body?: string }
const requests: Recorded[] = [];

const fakeFetch: typeof fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push({ method, path: url.pathname, search: url.searchParams, body: typeof init?.body === "string" ? init.body : undefined });
  if (url.pathname === "/api/plan") {
    return Response.json({
      plan: "",
      origin: "claude-code",
      mode: "annotate-bundle",
      bundle: [
        { path: BETA, renderAs: "markdown" },
        { path: ALPHA, renderAs: "markdown" },
      ],
      filePath: ROOT,
      projectRoot: ROOT,
      documentDrafts: true,
      sharingEnabled: false,
      serverConfig: {},
    });
  }
  if (url.pathname === "/api/doc") {
    const path = url.searchParams.get("path") ?? "";
    return Response.json({ markdown: TEXT[path] ?? "", filepath: path, renderAs: "markdown" });
  }
  if (url.pathname === "/api/draft/document" && method === "GET") {
    const path = url.searchParams.get("path") ?? "";
    return Response.json({ found: true, annotations: [savedComment(path)], globalAttachments: [] });
  }
  if (url.pathname === "/api/draft" && method === "GET") return Response.json({ found: false }, { status: 404 });
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  return Response.json({ ok: true });
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (check()) return;
    await settle(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const switcherText = () => document.querySelector("[data-bundle-switcher]")?.textContent ?? "";

async function mount(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fakeFetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  await waitFor(() => switcherText().includes("1 of 2"), "the first file to open");
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) document.body.replaceChildren();
  memory.clear();
  requests.length = 0;
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

const docRequests = () => requests.filter((r) => r.path === "/api/doc").map((r) => r.search.get("path"));

describe.if(hasDom)("annotate bundle", () => {
  test("the first file opens by itself; the switcher and the file list keep the given order", async () => {
    await mount();
    expect(docRequests()[0]).toBe(BETA);
    expect(switcherText()).toContain("beta.md");
    expect(document.querySelector('[aria-label="Previous file"]')?.hasAttribute("disabled")).toBe(true);

    // The Files tab lists exactly the bundle, unsorted (beta before alpha),
    // labelled relative to the files' common directory.
    const items = Array.from(document.querySelectorAll<HTMLElement>(".file-tree-item")).map((el) => el.getAttribute("title"));
    expect(items).toEqual(["docs/beta.md", "alpha.md"]);
    // The bundle's directory is never walked as a folder.
    expect(requests.some((r) => r.path === "/api/reference/files")).toBe(false);
    // A bundle file has no in-document Close pill (it led to the folder's
    // empty "choose a file" state); the switcher moves between the files.
    const closePills = Array.from(document.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Close" && button.className.includes("text-[9px]"),
    );
    expect(closePills).toHaveLength(0);
  });

  test("Next opens the following file, and one Send Feedback has one section per file in bundle order", async () => {
    await mount();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Next file"]')!.click();
    });
    await waitFor(() => switcherText().includes("2 of 2"), "the second file");
    expect(switcherText()).toContain("alpha.md");
    expect(docRequests()).toContain(ALPHA);
    // Both files' saved comments are in the session now.
    await waitFor(() => !!document.querySelector("[data-decision-primary]")?.textContent?.includes("Send Feedback"), "Send Feedback");

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-decision-primary]")!.click();
    });
    await waitFor(() => requests.some((r) => r.path === "/api/feedback"), "the decision");
    const body = JSON.parse(requests.find((r) => r.path === "/api/feedback")!.body ?? "{}") as {
      feedback: string;
      annotations: { id: string; documentPath?: string }[];
    };

    // One section per file, in the order given (beta, then alpha), each comment once.
    const betaAt = body.feedback.indexOf(`## ${BETA}`);
    const alphaAt = body.feedback.indexOf(`## ${ALPHA}`);
    expect(betaAt).toBeGreaterThan(-1);
    expect(alphaAt).toBeGreaterThan(betaAt);
    expect(body.feedback.split("BETA_COMMENT_SENTINEL")).toHaveLength(2);
    expect(body.feedback.split("ALPHA_COMMENT_SENTINEL")).toHaveLength(2);
    expect(body.annotations.map((a) => [a.id, a.documentPath]).sort()).toEqual([
      ["saved-alpha", ALPHA],
      ["saved-beta", BETA],
    ]);
  });
});
