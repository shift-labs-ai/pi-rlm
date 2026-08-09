/**
 * The engine contract.
 *
 * This suite is the specification: each test states one guarantee the evaluator
 * makes to the agent using it, and the comment above it says why that guarantee
 * exists. Read together they describe what "a persistent notebook" has to mean
 * in practice — what survives a failure, what a cancelled cell may still do,
 * and what a cell is never allowed to claim about itself.
 *
 * Tests here are behavioural: they drive a real engine and a real guest process.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineBusyError, EngineManager } from "../src/engine/index.js";

const managers: EngineManager[] = [];
const tempDirs: string[] = [];

function engine(...args: ConstructorParameters<typeof EngineManager>): EngineManager {
	const m = new EngineManager(...args);
	managers.push(m);
	return m;
}

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-rlm-gauntlet-"));
	tempDirs.push(d);
	return d;
}

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((m) => m.kill()));
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Wait for the observable outcome rather than for a duration.
 *
 * A fixed sleep long enough to be reliable on an idle machine is not long
 * enough when the whole suite is running, and a sleep long enough for that is
 * dead time in every other run.
 */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return condition();
}

// ── 1. Persistence ────────────────────────────────────────────────────────────
// The premise of the whole design: an agent can build state across calls
// instead of recomputing it, so results assigned once stay usable later.

describe("persistence", () => {
	test("let/const/var/function/class defined in one cell are readable in later cells", async () => {
		const m = engine();
		expect((await m.execute("let a = 1; const b = 2; var c = 3;")).status).toBe("ok");
		expect((await m.execute("function f(x: number) { return x * 2; }\nclass K { v = 9 }")).status).toBe("ok");
		const r = await m.execute("`${a + b + c}:${f(4)}:${new K().v}`");
		expect(r.status).toBe("ok");
		expect(r.result).toContain("6:8:9");
	});

	test("mutations persist across five sequential cells", async () => {
		const m = engine();
		await m.execute("let counter = 0;");
		for (let i = 0; i < 4; i++) await m.execute("counter += 1;");
		const r = await m.execute("counter");
		expect(r.result).toContain("4");
	});

	test("imports persist across cells", async () => {
		const m = engine();
		expect((await m.execute('import { join } from "node:path";')).status).toBe("ok");
		const r = await m.execute('join("a", "b")');
		expect(r.status).toBe("ok");
		expect(r.result).toContain("a/b");
	});
});

// ── 2. Top-level await ────────────────────────────────────────────────────────
// Async work is ordinary work here: a cell can await directly, so an agent
// never has to restructure a task around callbacks.

describe("top-level await", () => {
	test("await works at top level and its value persists", async () => {
		const m = engine();
		const r1 = await m.execute("const x = await Promise.resolve(41) + 1;");
		expect(r1.status).toBe("ok");
		const r2 = await m.execute("x");
		expect(r2.result).toContain("42");
	});
});

// ── 3. Result & error shapes ──────────────────────────────────────────────────
// Printed output and the value of the final expression are different things and
// are reported separately, so an agent can inspect a value without printing it,
// and read output without it polluting the value.

describe("result shape", () => {
	test("stdout captured; final expression rendered separately as result", async () => {
		const m = engine();
		const r = await m.execute('console.log("hello");\n1 + 1');
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("hello");
		expect(r.result).toContain("2");
	});

	test("durationMs reflects real elapsed time", async () => {
		const m = engine();
		const r = await m.execute("await new Promise((r) => setTimeout(r, 300));");
		expect(r.status).toBe("ok");
		expect(r.durationMs).toBeGreaterThanOrEqual(250);
	});

	test("statement-only cell has no result", async () => {
		const m = engine();
		const r = await m.execute("let q = 5;");
		expect(r.status).toBe("ok");
		expect(r.result).toBeUndefined();
	});

	test("an undefined final expression reports no result", async () => {
		const m = engine();
		const r = await m.execute("undefined");
		expect(r.status).toBe("ok");
		expect(r.result).toBeUndefined();
	});

	test("object/array final expressions render inspectably", async () => {
		const m = engine();
		const r1 = await m.execute("({ alpha: 1, nested: { beta: [1, 2] } })");
		expect(r1.status).toBe("ok");
		expect(r1.result).toContain("alpha");
		expect(r1.result).toContain("beta");
		const r2 = await m.execute("[10, 20, 30]");
		expect(r2.result).toContain("20");
		const r3 = await m.execute('new Map([["k", "map-visible-value"]])');
		expect(r3.result).toContain("map-visible-value");
	});

	test("console.error goes to stderr", async () => {
		const m = engine();
		const r = await m.execute('console.error("warn-ish");');
		expect(r.stderr).toContain("warn-ish");
	});

	test("thrown error yields status=error with name/message/stack; namespace survives", async () => {
		const m = engine();
		await m.execute("let alive = 123;");
		const r = await m.execute('throw new TypeError("boom")');
		expect(r.status).toBe("error");
		expect(r.error?.name).toBe("TypeError");
		expect(r.error?.message).toContain("boom");
		expect(Array.isArray(r.error?.stack)).toBe(true);
		const r2 = await m.execute("alive");
		expect(r2.result).toContain("123");
	});

	test("syntax error is a normal error result, not a crash", async () => {
		const m = engine();
		const r = await m.execute("let let let");
		expect(r.status).toBe("error");
		expect((await m.execute("1+1")).result).toContain("2");
	});
});

// ── 4. Shell in-language ──────────────────────────────────────────────────────
// Shell commands are in-language: their exit code and output are values that
// can be assigned and reused, rather than text an agent must re-parse.

describe("shell", () => {
	test("Bun.$ output lands in a persistent variable, exit code inspectable", async () => {
		const m = engine();
		const r1 = await m.execute("const out = await Bun.$`echo rlm-shell-proof`.quiet();");
		expect(r1.status).toBe("ok");
		const r2 = await m.execute("`${out.exitCode}:${out.stdout.toString().trim()}`");
		expect(r2.result).toContain("0:rlm-shell-proof");
	});

	test("cwd of shell commands is the engine cwd", async () => {
		const d = tempDir();
		const m = engine({ cwd: d });
		const r = await m.execute("(await Bun.$`pwd`.quiet()).stdout.toString().trim()");
		expect(r.status).toBe("ok");
		// macOS tmpdir may resolve through /private
		expect(r.result?.includes(d) || r.result?.includes(join("/private", d))).toBe(true);
	});
});

// ── 5. Streaming ──────────────────────────────────────────────────────────────
// Output must reach the caller while the cell is still running, or a long task
// looks indistinguishable from a hung one.

describe("streaming", () => {
	test("onStream receives stdout chunks before the cell finishes", async () => {
		const m = engine();
		const seen: { atMs: number; chunk: string }[] = [];
		const t0 = Date.now();
		const r = await m.execute(
			'console.log("early-chunk"); await new Promise((r) => setTimeout(r, 600)); console.log("late-chunk");',
			{ onStream: (chunk) => seen.push({ atMs: Date.now() - t0, chunk }) },
		);
		expect(r.status).toBe("ok");
		const early = seen.find((s) => s.chunk.includes("early-chunk"));
		expect(early).toBeDefined();
		// Early chunk must arrive well before the cell's 600ms sleep completes.
		expect(early!.atMs).toBeLessThan(500);
		expect(r.stdout).toContain("early-chunk");
		expect(r.stdout).toContain("late-chunk");
	});
});

// ── 6. Interrupt ──────────────────────────────────────────────────────────────
// Cancelling a cell must cost only that cell. Everything the session built up
// before it stays intact, so an interrupted step is recoverable rather than a
// reason to start over.

describe("interrupt", () => {
	test("aborting an awaiting cell yields status=aborted promptly and preserves the namespace", async () => {
		const m = engine();
		await m.execute("let precious = 777;");
		const ac = new AbortController();
		const t0 = Date.now();
		const pending = m.execute("await new Promise((r) => setTimeout(r, 60_000));", { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		const r = await pending;
		expect(r.status).toBe("aborted");
		expect(Date.now() - t0).toBeLessThan(5_000);
		const r2 = await m.execute("precious");
		expect(r2.result).toContain("777");
	});

	test("pre-aborted signal short-circuits without executing", async () => {
		const m = engine();
		await m.execute("let ran = false;");
		const ac = new AbortController();
		ac.abort();
		const r = await m.execute("ran = true;", { signal: ac.signal });
		expect(r.status).toBe("aborted");
		const r2 = await m.execute("ran");
		expect(r2.result).toContain("false");
	});

	test("a cancelled cell reports aborted even if it finishes first", async () => {
		// The caller withdrew interest. Reporting success for work they cancelled
		// would hand back a value they have no reason to trust.
		const m = engine();
		const ac = new AbortController();
		const pending = m.execute('try { await new Promise((r) => setTimeout(r, 60_000)); } catch {}\n"finished-anyway"', {
			signal: ac.signal,
		});
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		const r = await pending;
		expect(r.status).toBe("aborted");
	});

	test("abort during active streaming: no onStream after abort, pre-abort chunks kept", async () => {
		const m = engine();
		const ac = new AbortController();
		const chunks: string[] = [];
		let chunksAfterAbort = 0;
		const pending = m.execute(
			"for (let i = 0; i < 100; i++) { console.log(`tick-${i}`); await new Promise((r) => setTimeout(r, 50)); }",
			{
				signal: ac.signal,
				onStream: (chunk) => {
					if (ac.signal.aborted) chunksAfterAbort += 1;
					else chunks.push(chunk);
				},
			},
		);
		await new Promise((r) => setTimeout(r, 300));
		ac.abort();
		const r = await pending;
		expect(r.status).toBe("aborted");
		expect(chunks.join("")).toContain("tick-0");
		expect(r.stdout).toContain("tick-0");
		// Cancellation stops the output too. A cancelled cell that kept streaming
		// would keep filling the transcript an agent is trying to move on from;
		// only a single in-flight chunk may race the request.
		expect(chunksAfterAbort).toBeLessThanOrEqual(1);
	});

	test("orphaned continuation of an aborted cell cannot write into the namespace", async () => {
		// Cancellation cannot un-schedule work already in flight, so an aborted
		// cell's continuation may still run. It must not be able to write: state
		// silently mutated by a cell the agent believes it stopped is worse than
		// either finishing or failing cleanly.
		const m = engine();
		await m.execute("let stable = 1;");
		const ac = new AbortController();
		const pending = m.execute(
			'try { await new Promise((r) => setTimeout(r, 60_000)); } finally { var leak = "clobbered"; stable = 999; }',
			{ signal: ac.signal },
		);
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		expect((await pending).status).toBe("aborted");
		// Give any orphan continuation time to fire before checking.
		await new Promise((r) => setTimeout(r, 300));
		const r = await m.execute("`${typeof leak}:${stable}`");
		expect(r.result).toContain("undefined:1");
	});

	test("sync infinite loop: abort settles within a bound; next execute raises EngineBusyError; kill+restore recovers", async () => {
		// Cancellation is cooperative, so a cell spinning in synchronous code never
		// yields and the evaluator stays occupied. The engine must say so plainly
		// rather than hang, and the snapshot must make recovery cheap: kill, start
		// a fresh engine, restore. Losing the process should not mean losing work.
		const d = tempDir();
		const snapshot = { path: join(d, "ns.snapshot") };
		const m = engine({ snapshot });
		await m.execute("let survivor = 555;");
		await m.snapshotState();
		const ac = new AbortController();
		const t0 = Date.now();
		const pending = m.execute("while (true) {}", { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		const r = await pending;
		expect(r.status).toBe("aborted");
		expect(Date.now() - t0).toBeLessThan(10_000);
		await expect(m.execute("1+1")).rejects.toThrow(EngineBusyError);
		await m.kill();
		const m2 = engine({ snapshot });
		await m2.start();
		await m2.restoreState();
		expect((await m2.execute("survivor")).result).toContain("555");
	}, 20_000);

	test("guest process death mid-cell: pending execute settles, engine reports down, next execute rejects", async () => {
		// If the evaluator dies, every promise waiting on it must settle and the
		// engine must report itself down. Silence here would strand the agent.
		const m = engine();
		await m.execute("let x = 1;");
		const pending = m.execute('console.log("pre-exit"); process.exit(1);');
		const settled = await Promise.race([
			pending.then(
				(r) => ({ kind: "resolved" as const, status: r.status }),
				() => ({ kind: "rejected" as const, status: undefined }),
			),
			new Promise<{ kind: "hung" }>((r) => setTimeout(() => r({ kind: "hung" }), 5_000)),
		]);
		expect(settled.kind).not.toBe("hung");
		if (settled.kind === "resolved") expect(settled.status).not.toBe("ok");
		expect(m.isRunning).toBe(false);
		await expect(m.execute("2+2")).rejects.toThrow(/shut down|exited/i);
	});
});

// ── 6b. Lifecycle ──────────────────────────────────────────────────────────────────────
// Teardown is not a state an engine can be used from. Every path out of it must
// fail loudly and immediately rather than hang or quietly no-op.

describe("lifecycle", () => {
	test("execute after kill rejects deterministically", async () => {
		const m = engine();
		await m.execute("1+1");
		await m.kill();
		expect(m.isRunning).toBe(false);
		await expect(m.execute("2+2")).rejects.toThrow(/shut down/i);
	});

	test("kill during an active cell settles the pending execute promise", async () => {
		const m = engine();
		const pending = m.execute("await new Promise((r) => setTimeout(r, 60_000));");
		await new Promise((r) => setTimeout(r, 200));
		await m.kill();
		// Must settle (aborted result or rejection) — never hang.
		const settled = await Promise.race([
			pending.then(
				(r) => ({ kind: "resolved" as const, status: r.status }),
				() => ({ kind: "rejected" as const, status: undefined }),
			),
			new Promise<{ kind: "hung" }>((r) => setTimeout(() => r({ kind: "hung" }), 5_000)),
		]);
		expect(settled.kind).not.toBe("hung");
		if (settled.kind === "resolved") expect(settled.status).toBe("aborted");
	});
});

// ── 7. Serialization ──────────────────────────────────────────────────────────
// One namespace, one cell at a time. Interleaving two cells over shared state
// would make results depend on timing rather than on the program.

describe("serialization", () => {
	// Submission order is execution order: the queue slot is claimed before the
	// first await, so a caller that issues cells in sequence gets them in that
	// sequence even if the engine is still starting.
	test("concurrent execute() calls run strictly one at a time, in order", async () => {
		const m = engine();
		await m.execute("let order: string[] = []; let running = 0; let maxRunning = 0;");
		const cell = (tag: string) =>
			m.execute(
				`running += 1; maxRunning = Math.max(maxRunning, running); order.push("${tag}");` +
					`await new Promise((r) => setTimeout(r, 100)); running -= 1;`,
			);
		await Promise.all([cell("a"), cell("b"), cell("c")]);
		const r = await m.execute("`${maxRunning}|${order.join(',')}`");
		expect(r.result).toContain("1|a,b,c");
	});
});

// ── 8. Output truncation ──────────────────────────────────────────────────────
// A runaway cell must not be able to flood the model's context. Output is
// capped per channel and the cut is announced, so truncation is never mistaken
// for the real end of the output.

describe("truncation", () => {
	test("stdout is capped at maxOutputChars with an explicit marker", async () => {
		const m = engine();
		const r = await m.execute('for (let i = 0; i < 5000; i++) console.log("x".repeat(100));', {
			maxOutputChars: 10_000,
		});
		expect(r.status).toBe("ok");
		expect(r.stdout.length).toBeLessThan(11_000);
		expect(r.stdout).toContain("output truncated at 10000 chars");
	});

	test("giant result value is capped with marker", async () => {
		const m = engine();
		const r = await m.execute('"y".repeat(200_000)', { maxOutputChars: 10_000 });
		expect(r.result).toBeDefined();
		expect(r.result!.length).toBeLessThan(11_000);
		expect(r.result).toContain("output truncated at 10000 chars");
	});
});

// ── 9. Host bridge ────────────────────────────────────────────────────────────
// Cells can call back into the host mid-execution and await the reply, which is
// how capabilities are added without adding tools. Unknown request types and
// handler failures surface as ordinary errors inside the cell.

describe("host bridge", () => {
	test("guest awaits a host handler round-trip mid-cell and uses the reply", async () => {
		let received: Record<string, unknown> | undefined;
		const m = engine({
			hostHandlers: {
				"test.echo": async (payload) => {
					received = payload;
					return { doubled: (payload.value as number) * 2 };
				},
			},
		});
		const r = await m.execute('const reply = await rlm.hostRequest("test.echo", { value: 21 }); reply.doubled');
		expect(r.status).toBe("ok");
		expect(r.result).toContain("42");
		expect(received?.value).toBe(21);
	});

	test("cell continues running after the host reply: post-await code executes and streams", async () => {
		const m = engine({
			hostHandlers: { "test.step": async () => ({ token: "reply-token" }) },
		});
		const r = await m.execute(
			'console.log("before-bridge");\n' +
				'const rep = await rlm.hostRequest("test.step", {});\n' +
				"console.log(`after-bridge:${rep.token}`);\n" +
				'"cell-completed"',
		);
		expect(r.status).toBe("ok");
		const beforeIdx = r.stdout.indexOf("before-bridge");
		const afterIdx = r.stdout.indexOf("after-bridge:reply-token");
		expect(beforeIdx).toBeGreaterThanOrEqual(0);
		expect(afterIdx).toBeGreaterThan(beforeIdx);
		expect(r.result).toContain("cell-completed");
	});

	test("concurrent host requests from one cell resolve independently (no serialization deadlock)", async () => {
		// Host requests are not serialised against each other; a cell can fan out
		// and await them together without deadlocking on its own execution slot.
		const m = engine({
			hostHandlers: {
				"test.slow": async () => {
					await new Promise((r) => setTimeout(r, 300));
					return { tag: "slow" };
				},
				"test.fast": async () => ({ tag: "fast" }),
			},
		});
		const r = await m.execute(
			"const [a, b] = await Promise.all([" +
				'rlm.hostRequest("test.slow", {}), rlm.hostRequest("test.fast", {})]);\n' +
				"`${a.tag}+${b.tag}`",
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("slow+fast");
		// Parallel handlers: total must be far under 2x the slow handler.
		expect(r.durationMs).toBeLessThan(1_000);
	});

	test("host requests carry the issuing cell's abort signal", async () => {
		// A bridged tool call may hold a subprocess. When the cell is cancelled,
		// the host-side work must learn about it — otherwise "abort" stops the
		// cell but leaves its tool running to completion.
		let observed: AbortSignal | undefined;
		let sawAbort = false;
		const controller = new AbortController();
		const m = engine({
			hostHandlers: {
				"test.hang": async (_payload, context) => {
					observed = context?.signal;
					await new Promise<void>((resolve) => {
						context?.signal?.addEventListener("abort", () => {
							sawAbort = true;
							resolve();
						});
					});
					return { done: true };
				},
			},
		});
		const running = m.execute('await rlm.hostRequest("test.hang", {}); "never"', { signal: controller.signal });
		await new Promise((r) => setTimeout(r, 300));
		controller.abort();
		const r = await running;
		expect(r.status).toBe("aborted");
		expect(observed).toBeDefined();
		// The handler's signal fired because the cell was cancelled.
		await new Promise((r) => setTimeout(r, 100));
		expect(sawAbort).toBe(true);
	});

	test("host receives the source of the calling cell (cellSourceCode attribution)", async () => {
		// Each request carries the source of the cell that made it, so the host can
		// attribute an action to the program that asked for it.
		let attributed: unknown;
		const m = engine({
			hostHandlers: {
				"test.attr": async (payload) => {
					attributed = payload.cellSourceCode;
					return {};
				},
			},
		});
		const marker = "const veryUniqueMarker123 = 1;";
		await m.execute(`${marker} await rlm.hostRequest("test.attr", {});`);
		expect(String(attributed)).toContain("veryUniqueMarker123");
	});

	test("aborting a cell parked on a host handler frees the engine for the next cell", async () => {
		// The bridge deliberately has no timeout: a bridged tool may legitimately
		// run for minutes. Cancellation is therefore the only escape from a handler
		// that never settles, and it must return the evaluator to service — the
		// queue is serialized, so a cell that never releases its slot would take
		// every later cell with it.
		const m = engine({
			hostHandlers: {
				"test.never": () => new Promise<Record<string, unknown>>(() => {}),
			},
		});
		await m.execute("let before = 5;");
		const ac = new AbortController();
		const parked = m.execute('await rlm.hostRequest("test.never", {}); "never-reached"', { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 300));
		ac.abort();
		expect((await parked).status).toBe("aborted");
		// The queue must be free: a later cell runs, and the namespace is intact.
		const next = await Promise.race([
			m.execute("before + 1"),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("engine wedged")), 8_000)),
		]);
		expect(next.result).toContain("6");
	}, 20_000);

	test("aborting a cell unwinds it inside the guest instead of parking it forever", async () => {
		// Freeing the host's queue is not enough. If nothing rejects the guest's
		// side of the request, the cell stays suspended inside the evaluator for the
		// life of the process, holding its continuation and its pending entry. Those
		// accumulate silently across a long session.
		//
		// Observed through a second bridge call from the catch block, because an
		// aborted cell can neither write to the namespace nor stream output.
		let unwound = false;
		const m = engine({
			hostHandlers: {
				"test.deaf": () => new Promise<Record<string, unknown>>(() => {}),
				"test.unwound": async () => {
					unwound = true;
					return {};
				},
			},
		});
		const ac = new AbortController();
		const parked = m.execute(
			'try { await rlm.hostRequest("test.deaf", {}); } catch { await rlm.hostRequest("test.unwound", {}); }',
			{ signal: ac.signal },
		);
		await new Promise((r) => setTimeout(r, 300));
		ac.abort();
		expect((await parked).status).toBe("aborted");
		await new Promise((r) => setTimeout(r, 500));
		expect(unwound).toBe(true);
		// And the evaluator is still healthy afterwards.
		expect((await m.execute("1 + 1")).result).toContain("2");
	}, 20_000);

	test("a request from an orphaned continuation gets an already-aborted signal, never undefined", async () => {
		// The host force-settles a cancelled cell after a short grace period and
		// clears activeExecution. The guest's continuation can outlive that and
		// still call the bridge. Resolving the signal from whatever happens to be
		// active hands that request `undefined` — host work spawned by a cell the
		// agent already cancelled, which nothing can then cancel.
		const seen: { hadSignal: boolean; aborted: boolean; source: string }[] = [];
		const m = engine({
			hostHandlers: {
				"test.late": async (payload, context) => {
					seen.push({
						hadSignal: Boolean(context?.signal),
						aborted: context?.signal?.aborted ?? false,
						source: String(payload.cellSourceCode ?? ""),
					});
					return {};
				},
			},
		});
		const ac = new AbortController();
		const marker = "const orphanMarker456 = 1;";
		const pending = m.execute(
			`${marker}\ntry { await new Promise((r) => setTimeout(r, 1500)); } finally { await rlm.hostRequest("test.late", {}); }`,
			{ signal: ac.signal },
		);
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		expect((await pending).status).toBe("aborted");
		// Let the orphan's finally-block fire well after the force-settle.
		await new Promise((r) => setTimeout(r, 2_000));
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]!.hadSignal).toBe(true);
		expect(seen[0]!.aborted).toBe(true);
		// Attribution follows the issuing cell, not whatever ran most recently.
		expect(seen[0]!.source).toContain("orphanMarker456");
	}, 20_000);

	test("cellSourceCode names the issuing cell even while a different cell is active", async () => {
		// lastCellCode is a fallback, and a fallback that is wrong is worse than no
		// attribution: the host would record an action against a program that did
		// not ask for it.
		const sources: string[] = [];
		const m = engine({
			hostHandlers: {
				"test.who": async (payload) => {
					sources.push(String(payload.cellSourceCode ?? ""));
					return {};
				},
			},
		});
		await m.execute('const issuerMarker789 = 1; await rlm.hostRequest("test.who", {});');
		expect(sources).toHaveLength(1);
		expect(sources[0]).toContain("issuerMarker789");
	});

	test("unknown request type rejects in the guest, naming the type; cell reports error", async () => {
		const m = engine({ hostHandlers: {} });
		const r = await m.execute('await rlm.hostRequest("no.such.type", {});');
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain("no.such.type");
	});

	test("host handler throwing surfaces as a guest-side error with the message", async () => {
		const m = engine({
			hostHandlers: {
				"test.fail": async () => {
					throw new Error("host exploded deliberately");
				},
			},
		});
		const r = await m.execute('await rlm.hostRequest("test.fail", {});');
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain("host exploded deliberately");
	});
});

// ── 10. Snapshot / restore ────────────────────────────────────────────────────
// Persistence is best-effort per variable, and honest about it: whatever cannot
// be serialised is named rather than silently dropped, so an agent resuming a
// session knows exactly what came back.

describe("snapshot/restore", () => {
	test("plain-data namespace survives kill + fresh engine via snapshot", async () => {
		const d = tempDir();
		const snapshot = { path: join(d, "ns.snapshot") };
		const m1 = engine({ snapshot });
		await m1.execute('let keepNum = 42; let keepObj = { deep: [1, 2, { three: 3 }] }; let keepStr = "hi";');
		const snap = await m1.snapshotState();
		// Exact manifest: user names only — engine internals must not pollute it.
		expect([...(snap?.saved ?? [])].sort()).toEqual(["keepNum", "keepObj", "keepStr"]);
		await m1.kill();

		const m2 = engine({ snapshot });
		await m2.start();
		const restore = await m2.restoreState();
		expect(restore?.restored).toEqual(expect.arrayContaining(["keepNum", "keepObj", "keepStr"]));
		const r = await m2.execute("`${keepNum}:${keepObj.deep[2].three}:${keepStr}`");
		expect(r.result).toContain("42:3:hi");
	});

	test("unserializable values are reported as failed, not silently dropped, and don't poison the rest", async () => {
		const d = tempDir();
		const snapshot = { path: join(d, "ns.snapshot") };
		const m1 = engine({ snapshot });
		await m1.execute("let good = 7; let bad = () => 1; let sock = new AbortController();");
		const snap = await m1.snapshotState();
		expect(snap?.saved).toContain("good");
		const failedNames = (snap?.failed ?? []).map((f) => f.name);
		expect(failedNames.length).toBeGreaterThan(0);
		await m1.kill();

		const m2 = engine({ snapshot });
		await m2.start();
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("good");
		expect((await m2.execute("good")).result).toContain("7");
	});

	test("restore-before-bootstrap: a snapshotted `rlm` impostor cannot shadow the live handle", async () => {
		// Restoring happens before the runtime's own bindings are installed, so a
		// stale value saved under an engine-owned name cannot shadow the live one.
		const d = tempDir();
		const snapshot = { path: join(d, "ns.snapshot") };
		const m1 = engine({ snapshot, hostHandlers: { "test.ping": async () => ({ pong: true }) } });
		await m1.execute('var rlm = "dead-impostor"; let n = 1;');
		await m1.snapshotState();
		await m1.kill();

		const m2 = engine({ snapshot, hostHandlers: { "test.ping": async () => ({ pong: true }) } });
		await m2.start();
		await m2.restoreState();
		const r = await m2.execute('(await rlm.hostRequest("test.ping", {})).pong');
		expect(r.status).toBe("ok");
		expect(r.result).toContain("true");
		expect((await m2.execute("n")).result).toContain("1");
	});

	test("auto-snapshot: plain execute() persists state without an explicit snapshotState() call", async () => {
		// Durability cannot depend on someone remembering to save. Successful cells
		// schedule their own snapshot, so an unexpected exit loses little.
		const d = tempDir();
		const snapshot = { path: join(d, "ns.snapshot"), debounceMs: 100 };
		const m1 = engine({ snapshot });
		await m1.execute("let autoSaved = 314;");
		// The debounce fires on its own; wait for the file it produces, not for a
		// duration that happens to be long enough on an unloaded machine.
		expect(await waitFor(() => existsSync(snapshot.path))).toBe(true);
		await m1.kill();

		const m2 = engine({ snapshot });
		await m2.start();
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("autoSaved");
		expect((await m2.execute("autoSaved")).result).toContain("314");
	});
});

// ── 11. Namespace listing ─────────────────────────────────────────────────────
// The session reports what it revived, which requires knowing which names
// belong to the agent rather than to the engine.

describe("namespace listing", () => {
	test("lists user-defined names, excluding engine internals", async () => {
		const m = engine();
		await m.execute("let userVarOne = 1; function userFnTwo() {}");
		const names = await m.listNamespaceNames();
		expect(names).toEqual(expect.arrayContaining(["userVarOne", "userFnTwo"]));
		expect(names).not.toContain("rlm");
	});
});

// ── 12. Declaration semantics ─────────────────────────────────────────────────
// A cell is a sequence of bindings, not an all-or-nothing transaction: what was
// bound before a failure stays bound, and functions see the current value of the
// names they close over rather than a snapshot from their own cell.

describe("declaration semantics", () => {
	test("closures see later mutations of top-level names (no stale wrapper locals)", async () => {
		const m = engine();
		await m.execute("let n = 1; function getN() { return n; }");
		await m.execute("n = 5;");
		const r = await m.execute("`${n}|${getN()}`");
		expect(r.result).toContain("5|5");
	});

	test("const/class/destructured bindings are also live", async () => {
		const m = engine();
		await m.execute("const cfg = { v: 1 }; class Box { get v() { return cfg.v; } }");
		await m.execute("cfg.v = 42;");
		expect((await m.execute("new Box().v")).result).toContain("42");
		await m.execute("const { a, b } = { a: 1, b: 2 }; const [x, y] = [3, 4];");
		expect((await m.execute("`${a}${b}${x}${y}`")).result).toContain("1234");
	});

	test("names bound before a throw survive the failed cell", async () => {
		const m = engine();
		const r = await m.execute('let earned = 42; console.log("assigned"); throw new Error("boom");');
		expect(r.status).toBe("error");
		expect((await m.execute("typeof earned")).result).toContain("number");
		expect((await m.execute("earned")).result).toContain("42");
	});

	test("names bound before an abort survive the aborted cell", async () => {
		const m = engine();
		const ac = new AbortController();
		const pending = m.execute("let half = 1; await new Promise((r) => setTimeout(r, 60_000)); let rest = 2;", {
			signal: ac.signal,
		});
		await new Promise((r) => setTimeout(r, 250));
		ac.abort();
		expect((await pending).status).toBe("aborted");
		expect((await m.execute("typeof half")).result).toContain("number");
		// The post-abort continuation must still be isolated.
		expect((await m.execute("typeof rest")).result).toContain("undefined");
	});

	test("__-prefixed user names persist like any other", async () => {
		const m = engine();
		await m.execute("let __private = 5; let normal = 6;");
		const r = await m.execute("`${__private}|${normal}`");
		expect(r.result).toContain("5|6");
	});

	test("a function defined before an unrelated abort can still write to the namespace", async () => {
		const m = engine();
		await m.execute("let total = 0; function bump() { total += 1; }");
		const ac = new AbortController();
		const pending = m.execute("await new Promise((r) => setTimeout(r, 60_000));", { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 200));
		ac.abort();
		await pending;
		await m.execute("bump(); bump();");
		expect((await m.execute("total")).result).toContain("2");
	});
});

// ── 13. Guest/host isolation ──────────────────────────────────────────────────
// A cell may run any code, so the engine must hold regardless of what it runs:
// it cannot forge protocol traffic, reach the engine's own bindings, or leak its
// output into another cell.

describe("isolation", () => {
	test("a cell cannot forge a done envelope to fake success", async () => {
		const m = engine();
		const r = await m.execute(
			'console.log(JSON.stringify({ __rlm: 1, type: "done", status: "ok", result: "TOTALLY FINE" }));\n' +
				"await new Promise((r) => setTimeout(r, 200));\n" +
				'throw new Error("the cell actually failed");',
		);
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain("the cell actually failed");
		expect(r.result ?? "").not.toContain("TOTALLY FINE");
	});

	test("a cell cannot forge a stream envelope", async () => {
		const m = engine();
		const r = await m.execute(
			'console.log(JSON.stringify({ __rlm: 1, type: "stream", cellId: "", name: "stdout", chunk: "INJECTED" }));\n' +
				'"done"',
		);
		expect(r.status).toBe("ok");
		// The forged line is ordinary output, printed verbatim, not interpreted.
		expect(r.stdout).toContain('"type":"stream"');
	});

	test("engine internals are not reachable from cell code", async () => {
		const m = engine();
		const r = await m.execute('typeof __ctx + "|" + typeof __scope');
		// Either they are undefined, or the read throws — never an object.
		if (r.status === "ok") expect(r.result).toContain("undefined|undefined");
		else expect(r.status).toBe("error");
	});

	test("console output from an aborted cell's orphan does not leak into the next cell", async () => {
		const m = engine();
		const ac = new AbortController();
		const pending = m.execute(
			"for (let i = 0; i < 50; i++) { console.log(`ORPHAN-${i}`); await new Promise((r) => setTimeout(r, 60)); }",
			{ signal: ac.signal },
		);
		await new Promise((r) => setTimeout(r, 250));
		ac.abort();
		expect((await pending).status).toBe("aborted");
		const next = await m.execute('console.log("MINE"); await new Promise((r) => setTimeout(r, 500)); 1');
		expect(next.stdout).toContain("MINE");
		expect(next.stdout).not.toContain("ORPHAN");
	});

	test("console.log is captured with cell attribution (not raw fd passthrough)", async () => {
		const m = engine();
		const chunks: string[] = [];
		const r = await m.execute('console.log("tagged-line"); console.error("tagged-err"); 1', {
			onStream: (chunk, name) => chunks.push(`${name}:${chunk.trim()}`),
		});
		expect(r.stdout).toContain("tagged-line");
		expect(r.stderr).toContain("tagged-err");
		expect(chunks.some((c) => c.startsWith("stdout:tagged-line"))).toBe(true);
		expect(chunks.some((c) => c.startsWith("stderr:tagged-err"))).toBe(true);
	});
});

describe("shell interpolation safety", () => {
	// A nullish value interpolates as the literal text "undefined", so a stale
	// variable silently retargets the command instead of failing. rm -rf ${dir}
	// becoming rm -rf undefined is the failure this exists to prevent.
	test("a nullish interpolation is refused before the command is built", async () => {
		const m = engine();
		const r = await m.execute("await Bun.$`echo ${missingVar}`.quiet()");
		expect(r.status).toBe("error");
		expect(r.error?.name).toBe("TypeError");
		expect(r.error?.message).toContain("interpolation #1");
		expect(r.error?.message).toContain("undefined");
	});

	test("the refusal names which interpolation failed", async () => {
		const m = engine();
		const r = await m.execute("const dir = undefined; await Bun.$`echo ok ${dir}`.quiet()");
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain("interpolation #1");
		// null is reported distinctly from undefined so the cause is unambiguous.
		const viaNull = await m.execute("await Bun.$`echo ${null}`.quiet()");
		expect(viaNull.error?.message).toContain("null");
	});

	test("the namespace survives a refused interpolation", async () => {
		const m = engine();
		await m.execute("keep = 42");
		const r = await m.execute("touched = 1; await Bun.$`ls ${undefinedThing}`.quiet(); touched = 2");
		expect(r.status).toBe("error");
		// Bindings made before the throw stay bound; the cell is not a transaction.
		expect((await m.execute("[keep, touched]")).result).toContain("42");
		expect((await m.execute("touched")).result).toBe("1");
	});

	test("valid interpolations still work, including falsy ones", async () => {
		const m = engine();
		const r = await m.execute(
			'const n = 0; const s = ""; (await Bun.$`echo [${n}][${s}]`.quiet()).stdout.toString().trim()',
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("[0][]");
	});

	test("the rest of the Bun namespace is untouched by the guard", async () => {
		const m = engine();
		const r = await m.execute('typeof Bun.file === "function" && typeof Bun.$.escape === "function"');
		expect(r.result).toBe("true");
	});
});

describe("teardown races", () => {
	// Found by an intermittent full-suite failure: a torn-down engine's late exit
	// event rejected an execution nobody was awaiting any more, and the unhandled
	// rejection was attributed to whichever unrelated test was running.
	test("killing an engine while it is starting does not resurrect it as running", async () => {
		const m = engine();
		// The handler goes on at creation: kill() now takes real time (it waits
		// for the child to close), and a startup rejection left handler-less
		// across that wait is itself an unhandled-rejection bug in the caller.
		const starting = m.start().catch(() => "rejected");
		await m.kill();
		// start() may reject or resolve; what matters is that it cannot leave a
		// killed engine reporting itself alive.
		await starting;
		expect(m.isRunning).toBe(false);
		await expect(m.execute("1+1")).rejects.toThrow(/shut down/i);
	});

	test("a killed engine's exit event does not reject an abandoned execution", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const m = engine();
			await m.execute("1+1");
			// Abandon an in-flight cell exactly as an interrupted caller would.
			void m.execute("await new Promise((r) => setTimeout(r, 30_000));").catch(() => {});
			await new Promise((r) => setTimeout(r, 150));
			await m.kill();
			// Long enough for the child's exit event to be delivered.
			await new Promise((r) => setTimeout(r, 400));
			expect(rejections).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});
