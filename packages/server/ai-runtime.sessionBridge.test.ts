import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createAIRuntime (Bun) with a session bridge", () => {
  // Runs in a child whose PATH holds only a fake `codex` that never runs (it
  // records a marker if it does), so without a bridge Claude and Codex would
  // both be registered.
  function fakeCodex(dir: string): string {
    const marker = join(dir, "codex-ran");
    const codex = join(dir, "codex");
    writeFileSync(codex, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
    chmodSync(codex, 0o755);
    return marker;
  }

  test("registers ONLY the bridge, refuses other providers, and detaches it before teardown", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "plannotator-bridge-runtime-"));
    tempDirs.push(dir);
    const marker = fakeCodex(dir);
    const runner = join(dir, "runner.ts");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
    writeFileSync(runner, `
      import { createAIRuntime } from ${JSON.stringify(runtimeUrl)};
      const asks = [];
      const bridge = {
        host: "opencode",
        modes: { turn: true, transient: false },
        status: () => "ready",
        ask: (req, sink, signal) => asks.push({ req, sink, signal }),
      };
      const runtime = await createAIRuntime({ cwd: ${JSON.stringify(dir)}, sessionBridge: bridge, getServerPort: () => 4321 });
      const caps = await (await runtime.endpoints["/api/ai/capabilities"](
        new Request("http://localhost/api/ai/capabilities?activate=codex-sdk"),
      )).json();
      const otherProviderStatus = {};
      for (const providerId of ["codex-sdk", "claude-agent-sdk"]) {
        otherProviderStatus[providerId] = (await runtime.endpoints["/api/ai/session"](new Request("http://localhost/api/ai/session", {
          method: "POST",
          headers: { host: "localhost:4321" },
          body: JSON.stringify({ providerId, context: { mode: "code-review", review: { patch: "" } } }),
        }))).status;
      }
      const createWithHost = (host) => runtime.endpoints["/api/ai/session"](new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { host },
        body: JSON.stringify({ providerId: "session-bridge", context: { mode: "code-review", review: { patch: "" } } }),
      }));
      const hostStatus = {};
      for (const host of ["localhost:4321", "127.0.0.1:4321", "127.9.8.7:4321", "[::1]:4321", "evil.example:4321", "localhost:9999", "localhost", "127.0.0.1.evil.example:4321"]) {
        hostStatus[host] = (await createWithHost(host)).status;
      }
      const created = await (await runtime.endpoints["/api/ai/session"](new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { host: "localhost:4321" },
        body: JSON.stringify({ providerId: "session-bridge", context: { mode: "code-review", review: { patch: "" } } }),
      }))).json();
      const rebound = await runtime.endpoints["/api/ai/query"](new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { host: "evil.example:4321" },
        body: JSON.stringify({ sessionId: created.sessionId, prompt: "q" }),
      }));
      const reboundStatus = rebound.status;
      const query = runtime.endpoints["/api/ai/query"](new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { host: "localhost:4321" },
        body: JSON.stringify({ sessionId: created.sessionId, prompt: "q" }),
      }));
      const response = await query;
      const reader = response.body.getReader();
      void reader.read();
      while (asks.length === 0) await new Promise((r) => setTimeout(r, 2));
      runtime.dispose();
      await new Promise((r) => setTimeout(r, 10));
      const bridgeEntry = caps.providers.find((p) => p.id === "session-bridge");
      const { existsSync } = await import("node:fs");
      console.log(JSON.stringify({
        providerIds: caps.providers.map((p) => p.id),
        defaultProvider: caps.defaultProvider,
        otherProviderStatus,
        codexRan: existsSync(${JSON.stringify(marker)}),
        label: bridgeEntry.label,
        status: bridgeEntry.sessionBridge.status,
        hostSignalAborted: asks[0].signal.aborted,
        hostStatus,
        reboundStatus,
        asksFromRebound: asks.length,
      }));
    `);
    const proc = Bun.spawn([process.execPath, runner], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      // With a host session attached, Ask AI talks to it and nothing else:
      // no SDK provider is listed, activated, or reachable by id.
      providerIds: ["session-bridge"],
      defaultProvider: "session-bridge",
      otherProviderStatus: { "codex-sdk": 503, "claude-agent-sdk": 503 },
      codexRan: false,
      label: "Ask this session · OpenCode",
      status: "ready",
      // Teardown (a decision or exit) must not stop a turn the session runs for us.
      hostSignalAborted: false,
      // DNS-rebinding guard: only a loopback name with the server's own port.
      hostStatus: {
        "localhost:4321": 200,
        "127.0.0.1:4321": 200,
        "127.9.8.7:4321": 200,
        "[::1]:4321": 200,
        "evil.example:4321": 403,
        "localhost:9999": 403,
        localhost: 403,
        "127.0.0.1.evil.example:4321": 403,
      },
      reboundStatus: 403,
      asksFromRebound: 1,
    });
  }, 15_000);

  test("without a bridge the SDK providers are registered as before", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "plannotator-nobridge-runtime-"));
    tempDirs.push(dir);
    fakeCodex(dir);
    const runner = join(dir, "runner.ts");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
    writeFileSync(runner, `
      import { createAIRuntime } from ${JSON.stringify(runtimeUrl)};
      const runtime = await createAIRuntime({ cwd: ${JSON.stringify(dir)}, pullSessionBridge: null, getServerPort: () => 4321 });
      const caps = await (await runtime.endpoints["/api/ai/capabilities"](new Request("http://localhost/api/ai/capabilities"))).json();
      runtime.dispose();
      console.log(JSON.stringify({ providerIds: caps.providers.map((p) => p.id), defaultProvider: caps.defaultProvider }));
    `);
    const proc = Bun.spawn([process.execPath, runner], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      providerIds: ["claude-agent-sdk", "codex-sdk"],
      defaultProvider: "claude-agent-sdk",
    });
  }, 15_000);

  // A host that launched this server as a separate process (OpenCode plugin,
  // Claude Code mod) hands it a bridge token through the environment.
  async function runPullRunner(extraEnv: Record<string, string>, options: { discardFirst?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-pull-runtime-"));
    tempDirs.push(dir);
    const runner = join(dir, "runner.ts");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
    writeFileSync(runner, `
      import { createAIRuntime, discardEnvPullSessionBridgeConfig } from ${JSON.stringify(runtimeUrl)};
      ${options.discardFirst ? "discardEnvPullSessionBridgeConfig();" : ""}
      const runtime = await createAIRuntime({ cwd: ${JSON.stringify(dir)}, getServerPort: () => 4321 });
      const caps = await (await runtime.endpoints["/api/ai/capabilities"](new Request("http://localhost/api/ai/capabilities"))).json();
      const poll = (headers) => runtime.endpoints["/api/ai/bridge/poll"](new Request("http://localhost/api/ai/bridge/poll", {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "busy", waitMs: 0 }),
      }));
      const token = ${JSON.stringify("k".repeat(43))};
      const statuses = {
        ok: (await poll({ host: "127.0.0.1:4321", authorization: "Bearer " + token })).status,
        rebinding: (await poll({ host: "evil.example:4321", authorization: "Bearer " + token })).status,
        badToken: (await poll({ host: "127.0.0.1:4321", authorization: "Bearer " + "x".repeat(43) })).status,
      };
      const after = await (await runtime.endpoints["/api/ai/capabilities"](new Request("http://localhost/api/ai/capabilities"))).json();
      runtime.dispose();
      const bridge = caps.providers.find((p) => p.id === "session-bridge");
      console.log(JSON.stringify({
        providerIds: caps.providers.map((p) => p.id),
        bridge: bridge ? { label: bridge.label, status: bridge.sessionBridge.status } : null,
        statusAfterPoll: after.providers.find((p) => p.id === "session-bridge")?.sessionBridge.status ?? null,
        statuses,
        tokenLeftInEnv: process.env.PLANNOTATOR_SESSION_BRIDGE_TOKEN ?? null,
      }));
    `);
    const proc = Bun.spawn([process.execPath, runner], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        PATH: `${dir}:/usr/bin:/bin`,
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_SESSION_BRIDGE_TOKEN: "k".repeat(43),
        PLANNOTATOR_SESSION_BRIDGE_HOST: "opencode",
        PLANNOTATOR_SESSION_BRIDGE_MODES: "turn,transient",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  }

  test("takes a pull bridge from the host's environment, scrubs the token, and guards the endpoints", async () => {
    if (process.platform === "win32") return;
    expect(await runPullRunner({})).toEqual({
      providerIds: ["session-bridge"],
      bridge: { label: "Ask this session · OpenCode", status: "ready" },
      statusAfterPoll: "busy",
      statuses: { ok: 200, rebinding: 403, badToken: 401 },
      tokenLeftInEnv: null,
    });
  }, 15_000);

  test("stays off in remote mode, and still scrubs the token", async () => {
    if (process.platform === "win32") return;
    const result = await runPullRunner({ PLANNOTATOR_REMOTE: "1" });
    expect(result.bridge).toBeNull();
    // No bridge, so Ask AI keeps its usual providers.
    expect(result.providerIds).toContain("claude-agent-sdk");
    expect(result.statuses.ok).toBe(404);
    expect(result.tokenLeftInEnv).toBeNull();
  }, 15_000);

  // The CLI's --tailscale path: the session is reachable from the tailnet, so
  // the host's config is thrown away for the process (not merely cached).
  test("a discarded env config is never served later in the process", async () => {
    if (process.platform === "win32") return;
    const result = await runPullRunner({}, { discardFirst: true });
    expect(result.bridge).toBeNull();
    expect(result.statuses.ok).toBe(404);
    expect(result.tokenLeftInEnv).toBeNull();
  }, 15_000);
});
