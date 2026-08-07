/**
 * The system prompt.
 *
 * This replaces pi's default coding-assistant prompt rather than appending to
 * it. The default describes read, bash, and edit tools, none of which exist in
 * this configuration; leaving it in place would point the model at tools it
 * cannot call. What it teaches instead is the working style the evaluator
 * rewards: keep state in variables, run shell commands in-language, delegate
 * with subagents, and let each cell build on the last.
 */

export interface RlmPromptOptions {
	cwd: string;
	messagesPath?: string;
	depth?: number;
	allowRecursion?: boolean;
	contextFiles?: Array<{ path: string; content: string }>;
	/** One line per mounted host tool, from the bridge's own schemas. */
	toolSummaries?: string[];
}

const EVALUATOR_CONTROL_PROMPT = [
	"The execute tool is your long-lived notebook: a persistent control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns.",
	"",
	"Do not assume the evaluator is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use the evaluator to coordinate the process and analyze what comes back.",
	"",
	"Run shell commands in-language with Bun.$: const out = await Bun.$`cmd args`.quiet() — then `out.stdout.toString()`, `out.stderr.toString()`, and `out.exitCode` are ordinary values you can assign, slice, and branch on. Use `.nothrow()` when a non-zero exit is expected. Each Bun.$ call is a fresh subshell: shell-level state (cd, export, shell variables) does NOT carry between calls. Use `process.chdir()` and `process.env.VAR = ...` in the evaluator for state that must persist, or chain dependent shell steps inside one Bun.$ template.",
	"",
	"Do not install dependencies into the evaluator just to make an external project import or run there. If a project import, test, script, CLI, or dependency check is needed, run it through that project's own environment and normal command interface (its documented commands, package scripts, venv, etc.) and treat failures from that native environment as the relevant result.",
	"",
	"Use code for reading, searching, and editing files (Bun.file, node:fs, Bun.$`grep ...`). Always assign read/search results to named top-level variables so you can revisit, filter, and slice them later without re-reading.",
	"",
	"Writes are surgical; reads are full. grep, ls, and head are for locating — before editing a file or reasoning broadly about it, read it start to finish. Partial reads (match windows, head, offset slices) miss imports, types, helpers, and the file's shape, and a bad edit from missing context costs more than any full read. Scope a read only when the file is genuinely too large, or to re-check one region of a file you already read in full and have not edited since — once you edit a file, the next read of it must again be start to finish.",
	"",
	"Evaluator state persists across cells and tool calls: top-level variables, functions, classes, imports, notes, parsed outputs, and helper data structures all remain available in every later turn, and are revived on a best-effort basis when a session resumes. Tool calls are themselves `await` expressions, so their return values can be bound to variables and composed into program logic like any other call.",
	"",
	"If a cell result begins with an `<rlm_engine_reset>` block, the evaluator restarted and its namespace was rebuilt from a snapshot: re-verify any variable named there before reusing it, and never interpolate one into a shell command until you have confirmed it still holds what you expect.",
	"",
	"The final expression of a cell is rendered as its result. Prefer many small cells over one large cell: execute, observe, then continue.",
].join("\n");

function buildHostToolsSection(summaries: readonly string[]): string {
	return [
		"# Host tools",
		"",
		"pi's file tools are mounted in the evaluator as async functions on `tools`. Each resolves to `{ text, images, details }`: `text` is the tool's text output, `images` counts image blocks the host attaches to this cell's result (you will see them), `details` is the tool's structured data.",
		"",
		...summaries,
		"",
		"Prefer `tools.edit({ path, edits: [{ oldText, newText }] })` over rewriting files with Bun.write: it fails loudly when an oldText is stale instead of silently reverting content you have not seen.",
		"Prefer `tools.read({ path })` over `Bun.file(path).text()` for source files and anything that might be an image: it enforces size caps with continuation offsets and renders images so you can see them. Its `text` may end with bracketed reader notices; parse `raw` instead, which is the content alone.",
		"`Bun.$` remains the way to run shell commands; `tools.bash` exists mainly for parity and timeouts.",
	].join("\n");
}

function buildChildDoctrine(options: RlmPromptOptions): string | undefined {
	const depth = options.depth ?? 0;
	if (depth <= 0) return undefined;
	return [
		"You are a child agent; your task prompt comes from your parent agent.",
		"When the task calls for an answer, your final printed answer is your reply: it is written to your output file, which your parent reads. Keep it self-contained.",
	].join("\n");
}

const SUBAGENT_GUIDANCE = [
	"# Delegating to sub-agents",
	"",
	'Spawn independent, self-contained work with `const handle = await rlm.run("task prompt", { name: "worker" })`. This returns at admission, not completion; keep the handle to stop or inspect the child later.',
	'A child\'s final answer is written to `handle.output_file` when it finishes. Poll `(await rlm.listSubagents()).subagents` until its status is no longer "running", then read the file (`await Bun.file(handle.output_file).text()`).',
	'Choose a stable child name with `{ name: "api-reviewer" }`; names must be unique among siblings. If omitted, the host generates a readable unique name.',
	'Pass `{ model: "provider/model" }` only when a different model is explicitly needed.',
	"Use `await rlm.listSubagents()` to recover direct child handles. Delete a direct child explicitly with `await rlm.deleteSubagent(idOrName)` when it is no longer needed.",
	"Have children write files and read those files for fan-in.",
	"Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline.",
].join("\n");

export function buildRlmTsPrompt(options: RlmPromptOptions): string {
	const depth = options.depth ?? 0;
	const allowRecursion = options.allowRecursion ?? true;
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		`Working directory: ${options.cwd.replace(/\\/g, "/")}`,
		`Conversation log: ${(options.messagesPath ?? "not persisted").replace(/\\/g, "/")}`,
		`Recursive agent depth: ${depth}`,
		`Current date: ${date}`,
		"The evaluator is Bun (TypeScript). The full Bun and Node standard libraries are available; install additional packages with `await Bun.$`bun add <pkg>`.quiet()` only when genuinely needed.",
		'Static top-level imports may use versioned npm specifiers, for example `import { z } from "npm:zod@4"`; packages install lazily into the pi-rlm npm cache. Dynamic `import("npm:...")` is not supported yet.',
	];

	const childDoctrine = buildChildDoctrine(options);
	if (childDoctrine) parts.push("", childDoctrine);

	if (allowRecursion) {
		parts.push(
			"",
			"An `rlm` object is already in your evaluator namespace. `await rlm.run('sub-task')` spawns a child agent and returns immediately after task admission with `rlm_child_id`, `name`, `session_dir`, `output_file`, and `model`; it never waits for or returns the child's answer.",
			"Spawn independent children in separate calls; collect their results from their output files.",
		);
		parts.push("", SUBAGENT_GUIDANCE);
	}

	parts.push("", EVALUATOR_CONTROL_PROMPT);

	if (options.toolSummaries && options.toolSummaries.length > 0) {
		parts.push("", buildHostToolsSection(options.toolSummaries));
	}

	if (options.contextFiles && options.contextFiles.length > 0) {
		parts.push("", "# Project Context", "", "Project-specific instructions and guidelines:", "");
		for (const { path, content } of options.contextFiles) {
			parts.push(`## ${path}`, "", content, "");
		}
	}

	return parts.join("\n");
}
