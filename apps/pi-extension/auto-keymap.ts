import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";


/**
 * Fork auto-remap: the fork's plan toggle is Alt+P, but on WSL/Windows Pi
 * reserves alt+p for app.model.cycleBackward and silently skips extension
 * shortcuts conflicting with reserved built-ins. keybindings.json can remap
 * built-ins, so on those platforms write {"app.model.cycleBackward": "alt+m"}
 * once — freeing alt+p (plan toggle) and giving alt+m the model cycle.
 * Only ever touches the cycleBackward default; never a user-set value.
 */
export function ensureAltPlanRemap(): boolean {
	const platform = process.platform;
	const wsl = platform === "win32" || (platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP));
	if (!wsl) return false;
	const path = `${getAgentDir()}/keybindings.json`;
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				config = parsed as Record<string, unknown>;
			}
		} catch {
			return false; // Corrupt user config: never rewrite it automatically.
		}
	}
	const current = config["app.model.cycleBackward"];
	if (current !== undefined && current !== "alt+p" && current !== "shift+ctrl+p") return false;
	config["app.model.cycleBackward"] = "alt+m";
	try {
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}
