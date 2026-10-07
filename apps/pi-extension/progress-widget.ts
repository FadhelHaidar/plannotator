import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatTodoList } from "./config.ts";

export type ProgressWidgetMode = "compact" | "full";

/** Presentation only: never shorten or mutate the execution checklist. */
export function createProgressWidget(
	items: ReadonlyArray<{ step: number; text: string; completed: boolean }>,
	theme: Pick<Theme, "fg">,
	mode: ProgressWidgetMode = "compact",
) {
	const snapshot = items.map((item) => ({ ...item }));
	const render = (width: number): string[] => {
		if (width <= 0 || snapshot.length === 0) return [];
		const { completedCount, totalCount } = formatTodoList(snapshot);
		const lines = [theme.fg("accent", `Plan: ${completedCount}/${totalCount} complete`)];

		// Compact: sliding window over pending work — done steps compact into the
		// summary row, hidden pending steps into the … N more row. Full: upstream
		// style, every step in plan order with struck-through completed rows.
		if (mode === "full") {
			for (const item of snapshot) {
				if (item.completed) {
					lines.push(theme.fg("success", "☑ ") + theme.fg("muted", `${item.step}. ${item.text}`.replace(/[\r\n\t]+/g, " ")));
				} else {
					lines.push(theme.fg("muted", "☐ ") + `${item.step}. ${item.text}`.replace(/[\r\n\t]+/g, " "));
				}
			}
		} else {
			const pending = snapshot.filter((item) => !item.completed);
			for (const item of pending.slice(0, 3)) {
				lines.push(theme.fg("muted", `☐ ${item.step}. `) + item.text.replace(/[\r\n\t]+/g, " "));
			}
			if (pending.length > 3) lines.push(theme.fg("muted", `… ${pending.length - 3} more pending`));
		}

		// truncateToWidth appends reset escapes around the ellipsis; account for
		// them so every rendered row truly fits the supplied widget width.
		return lines.map((line) => {
			const rendered = truncateToWidth(line, width);
			// truncateToWidth appends reset escapes around the ellipsis; its
			// returned string carries them, but the visible width still fits.
			const visible = rendered.replace(/\x1b\[[0-9;]*m/g, "");
			return visible.length <= width ? rendered : visible;
		});
	};
	return {
		invalidate() {}, // No cached theme strings or width-dependent layout.
		render,
	};
}
