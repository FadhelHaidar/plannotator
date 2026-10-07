import { describe, expect, test } from "bun:test";
import { createProgressWidget } from "./progress-widget.ts";

const THEME = { fg: (_color: string, text: string) => text } as never;
const items = (specs: Array<[number, string, boolean]>) =>
	specs.map(([step, text, completed]) => ({ step, text, completed }));

describe("progress widget", () => {
	test("renders summary and at most three pending steps", () => {
		const widget = createProgressWidget(
			items([
				[1, "one", true],
				[2, "two", false],
				[3, "three", true],
				[4, "four", false],
				[5, "five", false],
				[6, "six", false],
				[7, "seven", false],
			]),
			THEME,
		);
		const lines = widget.render(80);
		expect(lines[0]).toBe("Plan: 2/7 complete");
		expect(lines).toHaveLength(5);
		expect(lines.slice(1)).toEqual([
			"☐ 2. two",
			"☐ 4. four",
			"☐ 5. five",
			"… 2 more pending",
		]);
	});

	test("shows summary only when everything is complete", () => {
		const widget = createProgressWidget(items([[1, "one", true]]), THEME);
		expect(widget.render(80)).toEqual(["Plan: 1/1 complete"]);
	});

	test("narrow and zero widths truncate or render nothing", () => {
		const widget = createProgressWidget(items([[1, "a very long step name indeed", false]]), THEME);
		const narrow = widget.render(10);
		expect(narrow).toHaveLength(2);
		// Escapes around the ellipsis do not count as visible columns.
		expect(narrow[1]!.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(10);
		expect(widget.render(0)).toEqual([]);
		expect(widget.render(80)).toEqual(["Plan: 0/1 complete", "☐ 1. a very long step name indeed"]);
	});

	test("normalizes newlines and tabs in display text only", () => {
		const item = { step: 1, text: "line one\nline two\ttabbed", completed: false };
		const widget = createProgressWidget([item], THEME);
		expect(widget.render(80)[1]).toBe("☐ 1. line one line two tabbed");
		expect(item.text).toBe("line one\nline two\ttabbed");
	});
});

describe("progress widget full mode", () => {
	test("renders every step, completed struck-style rows first in plan order", () => {
		const widget = createProgressWidget(
			items([
				[1, "one", true],
				[2, "two", false],
				[3, "three", false],
			]),
			THEME,
			"full",
		);
		const lines = widget.render(80);
		expect(lines).toEqual([
			"Plan: 1/3 complete",
			"☑ 1. one",
			"☐ 2. two",
			"☐ 3. three",
		]);
	});

	test("compact stays the default and caps rows", () => {
		const widget = createProgressWidget(
			items([
				[1, "a", true],
				[2, "b", false],
				[3, "c", false],
				[4, "d", false],
				[5, "e", false],
			]),
			THEME,
		);
		expect(widget.render(80)).toHaveLength(5);
	});
});
