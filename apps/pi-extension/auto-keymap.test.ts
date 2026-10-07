import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAltPlanRemap } from "./auto-keymap.ts";

const WSL_ENV = { WSL_DISTRO_NAME: "Ubuntu-24.04" } as NodeJS.ProcessEnv;
const REAL_PLATFORM = process.platform;
const REAL_ENV = process.env;

function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "auto-keymap-"));
	process.env = { ...REAL_ENV, PI_CODING_AGENT_DIR: dir, ...WSL_ENV };
	Object.defineProperty(process, "platform", { value: "linux" });
	return dir;
}
function restore(dir: string) {
	rmSync(dir, { recursive: true, force: true });
	process.env = REAL_ENV;
	Object.defineProperty(process, "platform", { value: REAL_PLATFORM });
}

test("skips on non-WSL", () => {
	const dir = mkdtempSync(join(tmpdir(), "auto-keymap-"));
	process.env = { ...REAL_ENV, PI_CODING_AGENT_DIR: dir, WSL_DISTRO_NAME: "", WSL_INTEROP: "" };
	Object.defineProperty(process, "platform", { value: "linux" });
	expect(ensureAltPlanRemap()).toBe(false);
	restore(dir);
});

test("writes alt+m when cycleBackward is the WSL default alt+p", () => {
	const dir = sandbox();
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "app.model.cycleBackward": "alt+p", "other": "keep" }));
	expect(ensureAltPlanRemap()).toBe(true);
	const saved = JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf-8"));
	expect(saved["app.model.cycleBackward"]).toBe("alt+m");
	expect(saved["other"]).toBe("keep");
	restore(dir);
});

test("preserves a user-customized value", () => {
	const dir = sandbox();
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "app.model.cycleBackward": "ctrl+alt+k" }));
	expect(ensureAltPlanRemap()).toBe(false);
	expect(JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf-8"))["app.model.cycleBackward"]).toBe("ctrl+alt+k");
	restore(dir);
});

test("no file yet → create with just the remap", () => {
	const dir = sandbox();
	expect(ensureAltPlanRemap()).toBe(true);
	expect(JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf-8"))["app.model.cycleBackward"]).toBe("alt+m");
	restore(dir);
});
