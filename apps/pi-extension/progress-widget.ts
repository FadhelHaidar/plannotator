import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatTodoList } from "./config.ts";

/** Presentation only: never shorten or mutate the execution checklist. */
export function createProgressWidget(
	items: ReadonlyArray<{ step: number; text: string; completed: boolean }>,
	theme: Pick<Theme, "fg">,
) {
	const snapshot = items.map((item) => ({ ...item }));
	return {
		invalidate() {}, // No cached theme strings or width-dependent layout.
		render(width: number): string[] {
			if (width <= 0 || snapshot.length === 0) return [];
			const { completedCount, totalCount } = formatTodoList(snapshot);
			const pending = snapshot.filter((item) => !item.completed);
			const lines = [theme.fg("accent", `Plan: ${completedCount}/${totalCount} complete`)];
			for (const item of pending.slice(0, 3)) {
				lines.push(theme.fg("muted", `☐ ${item.step}. `) + item.text.replace(/[\r\n\t]+/g, " "));
			}
			if (pending.length > 3) lines.push(theme.fg("muted", `… ${pending.length - 3} more pending`));
			// truncateToWidth appends reset escapes around the ellipsis; account for
			// them so every rendered row truly fits the supplied widget width.
			return lines.map((line) => {
				const rendered = truncateToWidth(line, width);
				// truncateToWidth appends reset escapes around the ellipsis; its
				// returned string carries them, but the visible width still fits.
				const visible = rendered.replace(/\x1b\[[0-9;]*m/g, "");
				return visible.length <= width ? rendered : visible;
			});
		},
	};
}
