/**
 * Unit coverage for the pieces the contract suite cannot reach directly.
 *
 * engine.contract.test.ts exercises behaviour end to end, which leaves gaps:
 * the cell transform runs inside the guest process, and protocol framing,
 * prompt assembly, and cell layout are only observed through their effects.
 * Those are tested here in isolation, where their edge cases are reachable.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage } from "../src/engine/protocol.js";
import { transformCell } from "../src/engine/transform.js";
import { buildRlmTsPrompt } from "../src/extension/prompt.js";
import {
	backgroundFor,
	closeOpenSgr,
	type ExecuteRenderState,
	formatDuration,
	isShellish,
	paintBackground,
	type RenderDeps,
	renderExecuteCell,
	statusKind,
} from "../src/extension/render-core.js";
import { createSubagentHost, defaultSubagentName, MAX_SUBAGENT_NAME_LENGTH } from "../src/extension/subagents.js";

// ── transform ─────────────────────────────────────────────────────────────────

describe("transform: types and declarations", () => {
	test("strips TypeScript annotations", () => {
		const { body } = transformCell("const x: number = 1; function f(a: string): string { return a; }");
		expect(body).not.toContain(": number");
		expect(body).not.toContain(": string");
	});

	test("collects names from every top-level declaration form", () => {
		const { declaredNames } = transformCell(
			"let a = 1, b = 2;\nconst c = 3;\nvar d = 4;\nfunction fn() {}\nclass Cls {}",
		);
		expect(declaredNames.sort()).toEqual(["Cls", "a", "b", "c", "d", "fn"]);
	});

	test("collects destructured names: object, array, rest, default, nested", () => {
		const { declaredNames } = transformCell(
			"const { p, q: renamed, ...restObj } = o;\nconst [first, , third = 9, ...restArr] = arr;\nconst { deep: { inner } } = o2;",
		);
		expect(declaredNames.sort()).toEqual(["first", "inner", "p", "renamed", "restArr", "restObj", "third"].sort());
	});

	test("deduplicates repeated names", () => {
		// `var` may legally redeclare; the name must appear once in the manifest.
		const { declaredNames } = transformCell("var dup = 1;\nvar dup = 2;");
		expect(declaredNames).toEqual(["dup"]);
	});
});

describe("transform: imports", () => {
	test("named imports become an awaited dynamic import", () => {
		const { body, declaredNames } = transformCell('import { join, resolve } from "node:path";');
		expect(body).toContain('await import("node:path")');
		expect(body).toContain("join");
		expect(declaredNames.sort()).toEqual(["join", "resolve"]);
	});

	test("default and aliased imports are destructured correctly", () => {
		const { body } = transformCell('import fsDefault from "node:fs";');
		expect(body).toContain("default: fsDefault");
		const aliased = transformCell('import { join as pathJoin } from "node:path";');
		expect(aliased.body).toContain('"join": pathJoin');
		expect(aliased.declaredNames).toEqual(["pathJoin"]);
	});

	test("namespace import binds the whole module", () => {
		const { body, declaredNames } = transformCell('import * as path from "node:path";');
		expect(body).toContain('path = await import("node:path")');
		expect(declaredNames).toEqual(["path"]);
	});

	test("side-effect-only import still awaits the module", () => {
		const { body, declaredNames } = transformCell('import "node:path";');
		expect(body).toContain('await import("node:path")');
		expect(declaredNames).toEqual([]);
	});

	test("npm imports use the guest cache importer", () => {
		const { body, declaredNames } = transformCell('import { z } from "npm:zod@4";', { ctxName: "ctx" });
		expect(body).toContain('await ctx.importModule("npm:zod@4")');
		expect(body).not.toContain('await import("npm:zod@4")');
		expect(declaredNames).toEqual(["z"]);
	});

	test("export statements are rejected with a clear SyntaxError", () => {
		expect(() => transformCell("export const nope = 1;")).toThrow(/export/i);
		expect(() => transformCell("export default 1;")).toThrow(/export/i);
	});
});

describe("transform: result capture", () => {
	test("a trailing expression is captured as the cell result", () => {
		const { body } = transformCell("const a = 1;\na + 1");
		expect(body).toContain("__ctx.setResult(");
	});

	test("a statement-only cell captures no result", () => {
		expect(transformCell("let q = 5;")).toMatchObject({ body: expect.not.stringContaining("setResult") });
		expect(transformCell("function f() { return 1; }").body).not.toContain("setResult");
		expect(transformCell("if (true) { 1; }").body).not.toContain("setResult");
	});

	test("side-effect-free trailing expressions are not dead-code eliminated", () => {
		// The transpiler's dead-code elimination would delete these as pointless;
		// they are the cell's result, so it stays off.
		expect(transformCell('"just-a-string"').body).toContain("setResult");
		expect(transformCell("({ a: 1 })").body).toContain("setResult");
		expect(transformCell("[1, 2, 3]").body).toContain("setResult");
	});
});

describe("transform: syntax edge cases", () => {
	const cases: Array<[string, string]> = [
		["regex vs division", 'const s = "aXbXc"; s.split(/X/).length'],
		["template with braces", "const k = 2; `v=${ { a: 1 }.a + k }`"],
		["template containing the word import", "`this mentions import { x } from 'y' inside a string`"],
		["trailing comment", "1 + 1 // trailing comment"],
		["comment-only cell", "// nothing but a comment"],
		["no semicolons", "const p = 1\nconst q = 2\np + q"],
		["labeled statement", 'outer: for (const i of [1, 2]) { break outer; }\n"labeled-ok"'],
		["generator and async fn", "function* gen() { yield 1; }\nasync function ay() { return 1; }\n1"],
		["optional chaining and nullish", "const o = {}; o?.a?.b ?? 'fallback'"],
		["class with private field", "class P { #hidden = 1; get v() { return this.#hidden; } }\n1"],
	];
	for (const [label, code] of cases) {
		test(`parses: ${label}`, () => {
			expect(() => transformCell(code)).not.toThrow();
		});
	}

	test("a genuine syntax error still throws", () => {
		expect(() => transformCell("let let let")).toThrow();
	});
});

// ── protocol ──────────────────────────────────────────────────────────────────

describe("protocol framing", () => {
	test("encode produces exactly one newline-terminated envelope line", () => {
		const line = encodeMessage({ type: "ping", id: "p1" });
		expect(line.endsWith("\n")).toBe(true);
		expect(line.trimEnd().split("\n")).toHaveLength(1);
		expect(line).toContain('"__rlm":1');
	});

	test("round-trips a message", () => {
		const decoded = decodeMessage<{ type: string; id: string }>(encodeMessage({ type: "pong", id: "abc" }));
		expect(decoded).toMatchObject({ type: "pong", id: "abc" });
	});

	test("rejects non-envelope, malformed, and typeless lines", () => {
		expect(decodeMessage("plain subprocess output")).toBeNull();
		expect(decodeMessage('{"__rlm":1, broken json')).toBeNull();
		expect(decodeMessage(JSON.stringify({ __rlm: 1 }))).toBeNull();
		expect(decodeMessage(JSON.stringify({ __rlm: 2, type: "done" }))).toBeNull();
		expect(decodeMessage("")).toBeNull();
	});
});

// ── prompt ────────────────────────────────────────────────────────────────────

describe("system prompt", () => {
	test("states identity, cwd, depth, and the evaluator doctrine", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp/work", messagesPath: "/tmp/s.jsonl", depth: 0 });
		expect(prompt).toContain("general purpose agent that uses code");
		expect(prompt).toContain("/tmp/work");
		expect(prompt).toContain("/tmp/s.jsonl");
		expect(prompt).toContain("Recursive agent depth: 0");
		expect(prompt).toContain("Bun.$");
		expect(prompt).toContain("persist");
		// The reset notice is only useful if the model knows what to do with it:
		// re-verify before reuse, and above all before shell interpolation.
		expect(prompt).toContain("<rlm_engine_reset>");
		expect(prompt).toContain("re-verify");
		expect(prompt).toContain("shell command");
	});

	test("subagent guidance appears only when recursion is allowed", () => {
		const withRecursion = buildRlmTsPrompt({ cwd: "/tmp", allowRecursion: true });
		expect(withRecursion).toContain("rlm.run");
		expect(withRecursion).toContain("Delegating to sub-agents");
		const without = buildRlmTsPrompt({ cwd: "/tmp", allowRecursion: false });
		expect(without).not.toContain("Delegating to sub-agents");
	});

	test("child doctrine appears only at depth > 0", () => {
		// "child agent" alone also appears in the subagent guidance; the doctrine's
		// identity sentence is the distinctive marker.
		expect(buildRlmTsPrompt({ cwd: "/tmp", depth: 0 })).not.toContain("You are a child agent");
		const child = buildRlmTsPrompt({ cwd: "/tmp", depth: 1 });
		expect(child).toContain("You are a child agent");
		expect(child).toContain("output file");
	});

	test("context files are appended verbatim under a project section", () => {
		const prompt = buildRlmTsPrompt({
			cwd: "/tmp",
			contextFiles: [{ path: "AGENTS.md", content: "PROJECT_RULE_MARKER" }],
		});
		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("AGENTS.md");
		expect(prompt).toContain("PROJECT_RULE_MARKER");
	});

	test("reads-are-full doctrine is stated", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp" });
		expect(prompt).toContain("Writes are surgical; reads are full");
		expect(prompt).toContain("read it start to finish");
		// The re-check shortcut dies with the first edit: an edited file must be
		// reread whole, because memory of edited files drifts fastest.
		expect(prompt).toContain("have not edited since");
	});

	test("host tools section appears only when summaries are supplied, with doctrine", () => {
		const withTools = buildRlmTsPrompt({
			cwd: "/tmp",
			toolSummaries: ["tools.read({ path: string }) — Read the contents of a file."],
		});
		expect(withTools).toContain("# Host tools");
		expect(withTools).toContain("tools.read({ path: string })");
		// The doctrine: edits over rewrites, tools.read for source/images, Bun.$ for shell.
		expect(withTools).toContain("tools.edit");
		expect(withTools).toContain("fails loudly");
		expect(withTools).toContain("Bun.$` remains the way to run shell commands");
		expect(buildRlmTsPrompt({ cwd: "/tmp" })).not.toContain("# Host tools");
	});

	test("no unresolved template placeholders leak into the prompt", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp", depth: 1 });
		expect(prompt).not.toContain("undefined");
		expect(prompt).not.toMatch(/\$\{/);
	});
});

// ── render-core ───────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

function testDeps(overrides: Partial<RenderDeps> = {}): RenderDeps {
	return {
		fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
		getBgAnsi: () => "\x1b[44m",
		highlight: (line) => `\x1b[32m${line}\x1b[0m`,
		keyHint: (expanded) => (expanded ? "ctrl+o to collapse" : "ctrl+o to expand"),
		visibleWidth: (text) => stripAnsi(text).length,
		truncateToWidth: (text, width, ellipsis = "") => {
			// ANSI-aware like the real primitive: keep escapes, count only visible
			// characters, and append the ellipsis when content was dropped.
			const plainLength = stripAnsi(text).length;
			if (plainLength <= width) return text;
			const budget = Math.max(0, width - stripAnsi(ellipsis).length);
			let visible = 0;
			let out = "";
			let index = 0;
			while (index < text.length) {
				const match = text.slice(index).match(/^\x1b\[[0-9;]*m/);
				if (match) {
					out += match[0];
					index += match[0].length;
					continue;
				}
				if (visible >= budget) break;
				out += text[index];
				visible += 1;
				index += 1;
			}
			return out + ellipsis;
		},
		wrapTextWithAnsi: (text, width) => {
			const plain = stripAnsi(text);
			if (plain.length <= width) return [text];
			const chunks: string[] = [];
			for (let i = 0; i < plain.length; i += width) chunks.push(plain.slice(i, i + width));
			return chunks;
		},
		now: () => 0,
		...overrides,
	};
}

function makeState(overrides: Partial<ExecuteRenderState> = {}): ExecuteRenderState {
	return {
		code: "const a = 1;\na + 1",
		details: { status: "ok", durationMs: 120, stdout: "hello\n", result: "2" },
		isPartial: false,
		isError: false,
		expanded: false,
		executionStarted: true,
		hasResult: true,
		...overrides,
	};
}

describe("render-core: helpers", () => {
	test("closeOpenSgr resets colors left open by wrapping", () => {
		expect(closeOpenSgr("\x1b[31mred")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("\x1b[38;5;10mgreen")).toBe("\x1b[38;5;10mgreen\x1b[0m");
		expect(closeOpenSgr("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("plain")).toBe("plain");
	});

	test("isShellish detects Bun.$ templates", () => {
		expect(isShellish("const out = await Bun.$`ls`.quiet();")).toBe(true);
		expect(isShellish("const out = 1;")).toBe(false);
	});

	test("formatDuration switches units at one second", () => {
		expect(formatDuration(undefined)).toBeUndefined();
		expect(formatDuration(120)).toBe("120ms");
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1500)).toBe("1.5s");
	});

	test("statusKind and backgroundFor agree on every state", () => {
		expect(statusKind(makeState())).toBe("done");
		expect(statusKind(makeState({ isError: true }))).toBe("error");
		expect(statusKind(makeState({ details: { status: "aborted" } }))).toBe("aborted");
		expect(statusKind(makeState({ details: undefined, hasResult: false, isPartial: true }))).toBe("running");
		expect(statusKind(makeState({ details: undefined, hasResult: false, executionStarted: false }))).toBe("queued");

		expect(backgroundFor("done")).toBe("toolSuccessBg");
		expect(backgroundFor("error")).toBe("toolErrorBg");
		expect(backgroundFor("aborted")).toBe("toolErrorBg");
		expect(backgroundFor("running")).toBe("toolPendingBg");
		expect(backgroundFor("queued")).toBe("toolPendingBg");
	});
});

describe("render-core: layout", () => {
	test("collapsed renders exactly one row; expanded renders code and output", () => {
		const deps = testDeps();
		const collapsed = renderExecuteCell(makeState(), 80, deps);
		expect(collapsed).toHaveLength(1);

		const expanded = renderExecuteCell(makeState({ expanded: true }), 80, deps);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
		const joined = stripAnsi(expanded.join("\n"));
		expect(joined).toContain("const a = 1;");
		expect(joined).toContain("hello");
	});

	test("every rendered line fits the pane width, at any width", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
			details: { status: "ok", durationMs: 90, stdout: "x".repeat(400), result: "y".repeat(200) },
		});
		for (const width of [20, 40, 80, 120, 200]) {
			for (const line of renderExecuteCell(state, width, deps)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});

	test("a long first line keeps the trailing metadata visible", () => {
		const deps = testDeps();
		const state = makeState({
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
		});
		// The preview absorbs truncation so the metadata suffix survives at any
		// width that can hold it; the preview is elided instead of the counts,
		// duration, and expand hint.
		for (const width of [80, 100, 140]) {
			const row = stripAnsi(renderExecuteCell(state, width, deps)[0]);
			expect(row).toContain("ctrl+o to expand");
			expect(row).toContain("120ms");
			expect(row).toContain("↑ 1");
			expect(row).toContain("const co");
			expect(row).toContain("…");
			expect(row.length).toBeLessThanOrEqual(width);
		}
	});

	test("status glyph and background track the cell status", () => {
		const deps = testDeps();
		expect(stripAnsi(renderExecuteCell(makeState(), 80, deps)[0])).toContain("✓");
		expect(stripAnsi(renderExecuteCell(makeState({ isError: true }), 80, deps)[0])).toContain("✗");
		const queued = makeState({ details: undefined, hasResult: false, executionStarted: false });
		expect(stripAnsi(renderExecuteCell(queued, 80, deps)[0])).toContain("◇");
	});

	test("line counts and duration appear in the collapsed row", () => {
		const deps = testDeps();
		const row = stripAnsi(renderExecuteCell(makeState(), 200, deps)[0]);
		expect(row).toContain("↑ 2");
		expect(row).toContain("lines");
		expect(row).toContain("120ms");
		expect(row).toContain("ctrl+o to expand");
	});

	test("error name and stack are surfaced", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			isError: true,
			details: { status: "error", errorName: "RangeError", errorStack: ["RangeError: demo explosion", "  at cell"] },
		});
		const rendered = stripAnsi(renderExecuteCell(state, 120, deps).join("\n"));
		expect(rendered).toContain("RangeError");
		expect(rendered).toContain("demo explosion");
	});

	test("empty output says so; a running cell says it is waiting", () => {
		const deps = testDeps();
		const done = makeState({ expanded: true, details: { status: "ok", durationMs: 5 } });
		expect(stripAnsi(renderExecuteCell(done, 80, deps).join("\n"))).toContain("no output");
		const running = makeState({ expanded: true, details: undefined, hasResult: false, isPartial: true });
		expect(stripAnsi(renderExecuteCell(running, 80, deps).join("\n"))).toContain("waiting for output");
	});

	test("background is re-armed after inner SGR resets so it spans the row", () => {
		const deps = testDeps();
		const painted = paintBackground("\x1b[31mred\x1b[0mplain", 20, "done", deps);
		expect(painted.startsWith("\x1b[44m")).toBe(true);
		expect(painted.endsWith("\x1b[0m")).toBe(true);
		// Every reset inside the row must be followed by the background again.
		const resets = painted.split("\x1b[0m");
		for (const segment of resets.slice(1, -1)) expect(segment.startsWith("\x1b[44m")).toBe(true);
		expect(stripAnsi(painted)).toHaveLength(20);
	});
});

// ── subagents: validation and defaults ────────────────────────────────────────

describe("subagent host: validation", () => {
	const dirs: string[] = [];
	function host() {
		const dir = mkdtempSync(join(tmpdir(), "pi-rlm-units-"));
		dirs.push(dir);
		return createSubagentHost({
			cwd: dir,
			subagentDir: dir,
			defaultModel: "anthropic/haiku",
			depth: 0,
			maxDepth: 2,
			spawnCommand: () => ({ command: "sh", args: ["-c", "true"] }),
		});
	}

	test("rejects a missing or empty prompt", async () => {
		const h = host();
		await expect(h.handlers["rlm.run"]({})).rejects.toThrow(/prompt/i);
		await expect(h.handlers["rlm.run"]({ prompt: "   " })).rejects.toThrow(/prompt/i);
	});

	test("rejects a non-string name and an oversized name", async () => {
		const h = host();
		await expect(h.handlers["rlm.run"]({ prompt: "t", kwargs: { name: 42 } })).rejects.toThrow(/name/i);
		await expect(
			h.handlers["rlm.run"]({ prompt: "t", kwargs: { name: "x".repeat(MAX_SUBAGENT_NAME_LENGTH + 1) } }),
		).rejects.toThrow(new RegExp(String(MAX_SUBAGENT_NAME_LENGTH)));
	});

	test("falls back to the default model and reports it on the handle", async () => {
		const h = host();
		const handle = await h.handlers["rlm.run"]({ prompt: "task" });
		expect(handle.model).toBe("anthropic/haiku");
		const explicit = await h.handlers["rlm.run"]({ prompt: "task", kwargs: { model: "anthropic/opus-5" } });
		expect(explicit.model).toBe("anthropic/opus-5");
	});

	test("delete rejects an unknown target and requires a non-empty one", async () => {
		const h = host();
		await expect(h.handlers["rlm.delete_subagent"]({ target: "nope" })).rejects.toThrow(/no subagent/i);
		await expect(h.handlers["rlm.delete_subagent"]({ target: "  " })).rejects.toThrow(/non-empty/i);
	});

	test("delete accepts the session name as well as the id", async () => {
		const h = host();
		const handle = await h.handlers["rlm.run"]({ prompt: "task", kwargs: { name: "by-name" } });
		const deleted = await h.handlers["rlm.delete_subagent"]({ target: "by-name" });
		expect((deleted.subagent as { rlm_child_id: string }).rlm_child_id).toBe(handle.rlm_child_id as string);
	});

	test("default names are slugged, bounded, and collision-resistant", () => {
		const name = defaultSubagentName("Fix the PARSER bug!! (urgent)", "sub-abcdef123456");
		expect(name.startsWith("subagent-fix-the-parser-bug")).toBe(true);
		expect(name.length).toBeLessThanOrEqual(MAX_SUBAGENT_NAME_LENGTH);
		expect(defaultSubagentName("x".repeat(500), "sub-1").length).toBeLessThanOrEqual(MAX_SUBAGENT_NAME_LENGTH);
		expect(defaultSubagentName("", "sub-99999999")).toContain("worker");
		const a = defaultSubagentName("same prompt", "sub-aaaaaaaa");
		const b = defaultSubagentName("same prompt", "sub-bbbbbbbb");
		expect(a).not.toBe(b);
	});

	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});
});
