/**
 * Path-keyed annotate drafts (packages/shared/annotate-draft.ts), driven over
 * HTTP against a real annotate server. Shared by the Bun suite
 * (annotate-draft.test.ts) and the Pi mirror
 * (apps/pi-extension/server/serverAnnotate-drafts.test.ts), so both runtimes
 * answer the same scenarios.
 *
 * Every test runs under a temp PLANNOTATOR_DATA_DIR; nothing touches the
 * real ~/.plannotator.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DraftScenarioServer {
  url: string;
  stop: () => void;
}

export type StartDraftScenarioServer = (options: {
  markdown: string;
  filePath: string;
  mode?: "annotate" | "annotate-folder";
  folderPath?: string;
}) => Promise<DraftScenarioServer>;

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_ANNOTATE_HISTORY",
] as const;

const comment = (id: string, text = id) => ({
  id,
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text,
  originalText: "Body",
  createdA: 1,
});

const draftBody = (generation: number, ids: string[]) => ({
  annotations: ids.map((id) => comment(id)),
  globalAttachments: [],
  draftGeneration: generation,
  ts: Date.now(),
});

const idsOf = (body: { annotations?: { id: string }[] }) => (body.annotations ?? []).map((a) => a.id);

export function defineAnnotateDraftScenarios(runtime: string, start: StartDraftScenarioServer): void {
  describe(`${runtime} annotate drafts follow the file`, () => {
    const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
    let root = "";
    let docDir = "";
    const servers: DraftScenarioServer[] = [];

    beforeEach(() => {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-annotate-draft-")));
      process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
      delete process.env.PLANNOTATOR_PORT;
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.PLANNOTATOR_AI = "disabled";
      process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
      docDir = join(root, "docs");
      mkdirSync(docDir, { recursive: true });
    });

    afterEach(() => {
      for (const server of servers.splice(0)) server.stop();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
      rmSync(root, { recursive: true, force: true });
    });

    /** Write the file with this text and open it alone. */
    async function openFile(name: string, text: string): Promise<DraftScenarioServer> {
      const filePath = join(docDir, name);
      writeFileSync(filePath, text);
      const server = await start({ markdown: text, filePath });
      servers.push(server);
      return server;
    }

    async function openFolder(): Promise<DraftScenarioServer> {
      const server = await start({ markdown: "", filePath: docDir, mode: "annotate-folder", folderPath: docDir });
      servers.push(server);
      return server;
    }

    function close(server: DraftScenarioServer): void {
      server.stop();
      servers.splice(servers.indexOf(server), 1);
    }

    const post = (server: DraftScenarioServer, path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const saveDocuments = (server: DraftScenarioServer, documents: { path: string; annotations: unknown[] }[]) =>
      post(server, "/api/draft/document", { documents });

    test("a comment comes back after the file is edited and the review reopened", async () => {
      const first = await openFile("notes.md", "# Notes\n\nBody v1\n");
      expect((await post(first, "/api/draft", draftBody(1, ["c1"]))).ok).toBe(true);
      close(first);

      const reopened = await openFile("notes.md", "# Notes\n\nBody v2, edited by the agent\n");
      const res = await fetch(`${reopened.url}/api/draft`);
      expect(res.status).toBe(200);
      const draft = await res.json();
      expect(idsOf(draft)).toEqual(["c1"]);
      // Server bookkeeping never reaches the client.
      expect(draft).not.toHaveProperty("patchKey");
      expect(draft).not.toHaveProperty("patchKeys");
      expect(draft).not.toHaveProperty("patchChanged");
    });

    test("the content copy wins unless the path copy is strictly newer", async () => {
      const onA = await openFile("plan.md", "# Plan\n\nText A\n");
      await post(onA, "/api/draft", draftBody(3, ["a"]));
      close(onA);
      const onB = await openFile("plan.md", "# Plan\n\nText B\n");
      await post(onB, "/api/draft", draftBody(5, ["b"]));
      close(onB);

      // Back to text A: its own copy (generation 3) is older than the path
      // copy written on B (generation 5), so the newer comments win.
      const backOnA = await openFile("plan.md", "# Plan\n\nText A\n");
      expect(idsOf(await (await fetch(`${backOnA.url}/api/draft`)).json())).toEqual(["b"]);
      await post(backOnA, "/api/draft", draftBody(6, ["a2"]));
      close(backOnA);

      // Text B's own copy is now the older one.
      const backOnB = await openFile("plan.md", "# Plan\n\nText B\n");
      expect(idsOf(await (await fetch(`${backOnB.url}/api/draft`)).json())).toEqual(["a2"]);
    });

    test("a decision clears the draft under both keys and its tombstone guards both", async () => {
      const first = await openFile("spec.md", "# Spec\n\nv1\n");
      await post(first, "/api/draft", draftBody(1, ["c1"]));
      expect((await post(first, "/api/feedback", { feedback: "fix it", annotations: [comment("c1")], draftGeneration: 2 })).ok).toBe(true);
      close(first);

      // Neither the edited file nor the unchanged one gets the submitted comments back.
      const edited = await openFile("spec.md", "# Spec\n\nv2\n");
      const missing = await fetch(`${edited.url}/api/draft`);
      expect(missing.status).toBe(404);
      expect((await missing.json()).draftGeneration).toBeGreaterThanOrEqual(2);
      // A stale tab's save at or below the decision's generation is refused
      // and reported; a newer one lands.
      const stale = await post(edited, "/api/draft", draftBody(2, ["ghost"]));
      expect(stale.status).toBe(409);
      expect((await fetch(`${edited.url}/api/draft`)).status).toBe(404);
      expect((await post(edited, "/api/draft", draftBody(3, ["fresh"]))).ok).toBe(true);
      close(edited);

      const unchanged = await openFile("spec.md", "# Spec\n\nv1\n");
      expect(idsOf(await (await fetch(`${unchanged.url}/api/draft`)).json())).toEqual(["fresh"]);
    });

    test("the reviewer's Close clears the path copy too", async () => {
      const first = await openFile("close.md", "# Close\n\nv1\n");
      await post(first, "/api/draft", draftBody(1, ["c1"]));
      expect((await fetch(`${first.url}/api/exit?generation=2`, { method: "POST" })).ok).toBe(true);
      close(first);
      const reopened = await openFile("close.md", "# Close\n\nv2\n");
      expect((await fetch(`${reopened.url}/api/draft`)).status).toBe(404);
    });

    test("local-file and folder sessions advertise document copies", async () => {
      const file = await openFile("advert.md", "# Advert\n");
      expect((await (await fetch(`${file.url}/api/plan`)).json()).documentDrafts).toBe(true);
      const folder = await openFolder();
      expect((await (await fetch(`${folder.url}/api/plan`)).json()).documentDrafts).toBe(true);
    });

    test("a URL session has neither a path copy nor document copies", async () => {
      const server = await start({ markdown: "# Page\n", filePath: "https://example.invalid/page" });
      servers.push(server);
      expect((await (await fetch(`${server.url}/api/plan`)).json()).documentDrafts).toBeUndefined();
      expect((await fetch(`${server.url}/api/draft/document?path=${encodeURIComponent(join(docDir, "x.md"))}`)).status).toBe(404);
    });

    test("a file's comments follow it from a folder session into a session on the file alone", async () => {
      const filePath = join(docDir, "a.md");
      writeFileSync(filePath, "# A\n\nBody\n");
      const folder = await openFolder();
      const res = await saveDocuments(folder, [{ path: filePath, annotations: [comment("from-folder")] }]);
      expect(res.ok).toBe(true);
      close(folder);

      const alone = await openFile("a.md", "# A\n\nBody, edited\n");
      expect(idsOf(await (await fetch(`${alone.url}/api/draft`)).json())).toEqual(["from-folder"]);
    });

    test("a file's comments follow it from a single-file session into a folder", async () => {
      const alone = await openFile("b.md", "# B\n\nBody\n");
      await post(alone, "/api/draft", draftBody(1, ["from-file"]));
      close(alone);

      const folder = await openFolder();
      const res = await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(join(docDir, "b.md"))}`);
      expect(res.status).toBe(200);
      expect(idsOf(await res.json())).toEqual(["from-file"]);
    });

    test("a folder decision clears the files it covered and refuses later writes", async () => {
      const covered = join(docDir, "covered.md");
      const untouched = join(docDir, "untouched.md");
      writeFileSync(covered, "# C\n");
      writeFileSync(untouched, "# U\n");

      // An earlier session left comments on a file this session never opens.
      const earlier = await openFolder();
      await saveDocuments(earlier, [{ path: untouched, annotations: [comment("keep")] }]);
      close(earlier);

      const folder = await openFolder();
      await saveDocuments(folder, [{ path: covered, annotations: [comment("sent")] }]);
      expect((await post(folder, "/api/feedback", { feedback: "x", annotations: [comment("sent")] })).ok).toBe(true);
      expect((await saveDocuments(folder, [{ path: covered, annotations: [comment("late")] }])).status).toBe(409);
      close(folder);

      const next = await openFolder();
      expect((await fetch(`${next.url}/api/draft/document?path=${encodeURIComponent(covered)}`)).status).toBe(404);
      const kept = await fetch(`${next.url}/api/draft/document?path=${encodeURIComponent(untouched)}`);
      expect(idsOf(await kept.json())).toEqual(["keep"]);
    });

    test("sending a document with no comments clears its copy", async () => {
      const filePath = join(docDir, "cleared.md");
      writeFileSync(filePath, "# Cleared\n");
      const folder = await openFolder();
      await saveDocuments(folder, [{ path: filePath, annotations: [comment("gone")] }]);
      await saveDocuments(folder, [{ path: filePath, annotations: [] }]);
      expect((await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(filePath)}`)).status).toBe(404);
    });

    test("paths outside the session, and a single-file session's own file, are refused", async () => {
      const outside = join(root, "elsewhere.md");
      writeFileSync(outside, "# Elsewhere\n");
      const folder = await openFolder();
      expect((await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(outside)}`)).status).toBe(403);
      const inside = join(docDir, "inside.md");
      const res = await saveDocuments(folder, [
        { path: outside, annotations: [comment("x")] },
        { path: inside, annotations: [comment("y")] },
      ]);
      const body = await res.json();
      expect(body.rejected).toEqual([outside]);
      expect(body.written).toBe(1);

      const alone = await openFile("own.md", "# Own\n");
      const own = await saveDocuments(alone, [{ path: join(docDir, "own.md"), annotations: [comment("z")] }]);
      expect((await own.json()).rejected).toEqual([join(docDir, "own.md")]);
    });
  });
}
