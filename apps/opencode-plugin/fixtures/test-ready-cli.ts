#!/usr/bin/env bun

// Stand-in for the `plannotator` binary where a test needs the server to come
// up: records its argv, stdin and whether it got a session-bridge token, writes
// the ready file the real server writes once listening (url only, no port, so
// no pull-bridge client starts against a server that does not exist), stays up
// briefly so the bridge's ready-file poll sees it, then prints the decision
// record the test asked for, or fails the way the test asked.

import { appendFileSync, writeFileSync } from "node:fs";

const stdin = await Bun.stdin.text();

const recordFile = process.env.PLANNOTATOR_TEST_RECORD_FILE;
if (recordFile) {
  writeFileSync(recordFile, JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    bridgeToken: Boolean(process.env.PLANNOTATOR_SESSION_BRIDGE_TOKEN),
  }), "utf8");
}

const failure = process.env.PLANNOTATOR_TEST_FAIL;
if (failure) {
  console.error(failure);
  process.exit(1);
}

const readyFile = process.env.PLANNOTATOR_READY_FILE;
const url = process.env.PLANNOTATOR_TEST_READY_URL;
if (readyFile && url) appendFileSync(readyFile, `${JSON.stringify({ url, isRemote: false })}\n`, "utf8");
await Bun.sleep(Number(process.env.PLANNOTATOR_TEST_HOLD_MS ?? 600));

console.log(process.env.PLANNOTATOR_TEST_OUTCOME ?? JSON.stringify({ decision: "dismissed" }));
