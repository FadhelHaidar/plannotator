/**
 * The `agentTool` setting through the Bun servers: POST /api/config accepts a
 * boolean and nothing else, and /api/plan's serverConfig carries what a
 * Settings toggle or a "turn the tool on" offer needs (the session's host, the
 * effective value, an env override). The Pi mirror is
 * apps/pi-extension/agent-tool-config.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import { loadConfig } from "./config";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AGENT_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-agent-tool-config-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  delete process.env.PLANNOTATOR_PORT;
  delete process.env.PLANNOTATOR_AGENT_TOOL;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("agentTool on the Bun annotate server", () => {
  test("POST /api/config saves a boolean, ignores anything else; serverConfig reports the host's view", async () => {
    const server = await startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "opencode" });
    const post = (body: unknown) =>
      fetch(`${server.url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const serverConfig = async () => ((await (await fetch(`${server.url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
    try {
      // Unset: OpenCode 2's default (off), marked as not chosen.
      expect(await serverConfig()).toMatchObject({ agentTool: false, agentToolConfigured: false, agentToolHost: "opencode", agentToolEnabled: false });

      for (const bad of ["true", 1, null]) expect((await post({ agentTool: bad })).status).toBe(200);
      expect(loadConfig().agentTool).toBeUndefined();

      expect((await post({ agentTool: true })).status).toBe(200);
      expect(loadConfig().agentTool).toBe(true);
      expect(await serverConfig()).toMatchObject({ agentTool: true, agentToolConfigured: true, agentToolEnabled: true });

      // An env override wins, and is reported so a toggle can say so.
      process.env.PLANNOTATOR_AGENT_TOOL = "0";
      expect(await serverConfig()).toMatchObject({ agentTool: true, agentToolEnv: false, agentToolEnabled: false });
    } finally {
      server.stop();
    }
  });
});
