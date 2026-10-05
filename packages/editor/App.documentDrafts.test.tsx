/**
 * A linked document's saved comments come back when it is opened
 * (per-document draft copies, hooks/useDocumentDrafts.ts).
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

const ROOT_PATH = "/tmp/docdrafts/index.md";
const LINKED_PATH = "/tmp/docdrafts/other.md";

const SAVED_COMMENT = {
  id: "saved-on-other",
  blockId: "",
  startOffset: 0,
  endOffset: 10,
  type: "COMMENT",
  text: "SAVED_COMMENT_SENTINEL",
  originalText: "Other body",
  createdA: 1,
};

interface Recorded { method: string; path: string; search: string; body?: string }
const requests: Recorded[] = [];

const fakeFetch: typeof fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === "string" ? init.body : undefined });
  if (url.pathname === "/api/plan") {
    return Response.json({
      plan: "# Index\n\nSee [the other doc](other.md) for details.\n",
      origin: "claude-code",
      mode: "annotate",
      filePath: ROOT_PATH,
      documentDrafts: true,
      sharingEnabled: false,
      serverConfig: {},
    });
  }
  if (url.pathname === "/api/doc") {
    return Response.json({ markdown: "# Other\n\nOther body text.\n", filepath: LINKED_PATH, renderAs: "markdown" });
  }
  if (url.pathname === "/api/draft/document" && method === "GET") {
    return Response.json({ found: true, annotations: [SAVED_COMMENT], globalAttachments: [] });
  }
  if (url.pathname === "/api/draft" && method === "GET") return Response.json({ found: false }, { status: 404 });
  if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
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
  for (let attempt = 0; attempt < 20; attempt += 1) await settle();
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

describe.if(hasDom)("per-document draft copies", () => {
  test("opening a linked document merges its saved comments in", async () => {
    await mount();
    const link = Array.from(document.querySelectorAll("a")).find((a) => a.textContent?.includes("the other doc"));
    if (!link) throw new Error("linked document link not rendered");
    await act(async () => { link.click(); });
    for (let attempt = 0; attempt < 12; attempt += 1) await settle(60);

    const read = requests.find((r) => r.path === "/api/draft/document" && r.method === "GET");
    expect(read?.search).toContain(encodeURIComponent(LINKED_PATH));
    // The saved comment is now the open document's (listed in the panel).
    expect(document.body.textContent).toContain("SAVED_COMMENT_SENTINEL");
    // The session draft is the ROOT's: the linked document's comments never
    // ride it; they stay under the linked document's own path.
    const sessionSaves = requests.filter((r) => r.path === "/api/draft" && r.method === "POST");
    for (const save of sessionSaves) expect(save.body ?? "").not.toContain("SAVED_COMMENT_SENTINEL");
  });
});
