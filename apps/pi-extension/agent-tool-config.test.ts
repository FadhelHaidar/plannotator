/**
 * The `agentTool` setting through the Pi (node:http) servers, the mirror of
 * packages/server/agent-tool-config.test.ts: POST /api/config accepts a
 * boolean and nothing else, and /api/plan's serverConfig reports the Pi
 * host's view (off by default on Pi).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./generated/config.ts";
import { startAnnotateServer } from "./server/serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AGENT_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-agent-tool-config-"));
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

describe("agentTool on the Pi annotate server", () => {
	test("POST /api/config saves a boolean, ignores anything else; serverConfig reports the Pi view", async () => {
		const server = await startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML });
		const post = (body: unknown) =>
			fetch(`${server.url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const serverConfig = async () => ((await (await fetch(`${server.url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
		try {
			expect(await serverConfig()).toMatchObject({ agentTool: false, agentToolConfigured: false, agentToolHost: "pi", agentToolEnabled: false });

			for (const bad of ["true", 1, null]) expect((await post({ agentTool: bad })).status).toBe(200);
			expect(loadConfig().agentTool).toBeUndefined();

			expect((await post({ agentTool: true })).status).toBe(200);
			expect(loadConfig().agentTool).toBe(true);
			expect(await serverConfig()).toMatchObject({ agentTool: true, agentToolConfigured: true, agentToolEnabled: true });

			process.env.PLANNOTATOR_AGENT_TOOL = "0";
			expect(await serverConfig()).toMatchObject({ agentTool: true, agentToolEnv: false, agentToolEnabled: false });
		} finally {
			server.stop();
		}
	});
});
