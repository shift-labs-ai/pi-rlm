/**
 * pi-rlm guest: the persistent Bun evaluator process.
 *
 * Owns the namespace and runs cells against it: each cell is executed inside a
 * `with` block over a proxy, so ordinary assignments become namespace entries
 * and ordinary reads resolve against it. Writes are refused once the owning
 * cell has been cancelled, which keeps a cancelled cell's still-running
 * continuation from mutating state a later cell is using.
 *
 * It also tags output with the cell that produced it, serves snapshot,
 * restore, and listing requests, and forwards host requests made from cells.
 *
 * Protocol traffic leaves on fd 3 and carries a nonce, so cell output can be
 * neither mistaken for nor forged into a protocol message.
 *
 * Runs as: bun guest.ts   (spawned by EngineManager)
 */

import { deserialize, serialize } from "bun:jsc";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { format } from "node:util";
import {
	decodeMessage,
	encodeMessage,
	type GuestToHostMessage,
	type HostToGuestMessage,
	NONCE_ENV,
	PROTOCOL_FD,
} from "./protocol.js";
import { transformCell } from "./transform.js";

// ── identity: nonce + unguessable internal names ─────────────────────────────
// The nonce is removed from the environment immediately so cell code cannot
// read it back and forge protocol traffic on fd 3.

const NONCE = process.env[NONCE_ENV] ?? "";
delete process.env[NONCE_ENV];
if (!NONCE) {
	writeSync(2, "pi-rlm guest started without a protocol nonce\n");
	process.exit(2);
}

const SCOPE_NAME = `__rlm_scope_${NONCE}`;
const CTX_NAME = `__rlm_ctx_${NONCE}`;
const INTERNAL_NAMES = new Set([SCOPE_NAME, CTX_NAME]);

// A pipe fd can be non-blocking: writeSync may write partially or throw EAGAIN
// when the host has not drained yet. Loop until the whole frame is out, or a
// half-written line would corrupt the protocol stream.
const backoff = new Int32Array(new SharedArrayBuffer(4));

function writeAllSync(fd: number, text: string): void {
	const buffer = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < buffer.length) {
		try {
			offset += writeSync(fd, buffer, offset, buffer.length - offset);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EAGAIN" || code === "EWOULDBLOCK") {
				Atomics.wait(backoff, 0, 0, 1);
				continue;
			}
			if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
				try {
					writeSync(2, "[guest] protocol pipe closed; exiting\n");
				} catch {}
				// The host closed the protocol pipe (killed or disposed this engine).
				// Nothing left to report to; exit quietly instead of crashing with an
				// uncaught error the host would surface as a spurious failure.
				process.exit(0);
			}
			throw error;
		}
	}
}

function send(message: GuestToHostMessage): void {
	writeAllSync(PROTOCOL_FD, encodeMessage(message, NONCE));
}

// ── namespace, cell context ──────────────────────────────────────────────────

type Namespace = Record<string, unknown>;
const namespace: Namespace = Object.create(null);

interface CellContext {
	cellId: string;
	/** Set when this cell is aborted; its later writes are discarded. */
	aborted: boolean;
	result?: { value: unknown };
	setResult(value: unknown): void;
}

const cellStorage = new AsyncLocalStorage<CellContext>();
let activeCell: CellContext | undefined;

function makeCellContext(cellId: string): CellContext {
	const ctx: CellContext = {
		cellId,
		aborted: false,
		setResult(value: unknown) {
			if (!ctx.aborted) ctx.result = { value };
		},
	};
	return ctx;
}

function makeScopeProxy(ctx: CellContext): Namespace {
	return new Proxy(namespace, {
		has(_target, key) {
			// Only the wrapper's own parameters are hidden, so user names — including
			// __-prefixed ones — resolve and persist normally.
			if (typeof key !== "string") return false;
			return !INTERNAL_NAMES.has(key);
		},
		get(target, key) {
			if (typeof key !== "string") return undefined;
			if (key in target) return target[key];
			return (globalThis as Record<string, unknown>)[key];
		},
		set(target, key, value) {
			// Writes from an aborted cell's orphaned continuation are dropped;
			// writes from cells that are merely older are not.
			if (typeof key === "string" && !ctx.aborted) target[key] = value;
			return true;
		},
	});
}

// ── user output capture ──────────────────────────────────────────────────────
// Bun's console does NOT route through process.stdout.write, so console methods
// are replaced directly. AsyncLocalStorage keeps attribution correct for output
// emitted by an orphaned continuation after its cell was aborted.

function emit(name: "stdout" | "stderr", text: string): void {
	const owner = cellStorage.getStore() ?? activeCell;
	send({ type: "stream", cellId: owner?.cellId ?? "", name, chunk: text });
}

function captureWrite(name: "stdout" | "stderr") {
	return (chunk: unknown, ...rest: unknown[]): boolean => {
		const text =
			typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
		emit(name, text);
		const callback = rest.find((r) => typeof r === "function") as (() => void) | undefined;
		callback?.();
		return true;
	};
}

process.stdout.write = captureWrite("stdout") as typeof process.stdout.write;
process.stderr.write = captureWrite("stderr") as typeof process.stderr.write;

function consoleWriter(name: "stdout" | "stderr") {
	return (...args: unknown[]): void => {
		emit(name, `${format(...args)}\n`);
	};
}

const consoleOut = consoleWriter("stdout");
const consoleErr = consoleWriter("stderr");
console.log = consoleOut;
console.info = consoleOut;
console.debug = consoleOut;
console.dir = consoleOut;
console.warn = consoleErr;
console.error = consoleErr;
console.trace = consoleErr;

// ── host bridge (rlm handle) ─────────────────────────────────────────────────

interface PendingHostRequest {
	/** The cell that issued this request; cancelling that cell rejects it. */
	cellId: string;
	resolve(payload: Record<string, unknown>): void;
	reject(error: Error): void;
}

const pendingHostRequests = new Map<string, PendingHostRequest>();
let hostRequestCounter = 0;

function hostRequest(requestType: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	if (typeof requestType !== "string" || requestType.length === 0) {
		return Promise.reject(new TypeError("requestType must be a non-empty string"));
	}
	const id = `hr-${++hostRequestCounter}`;
	const cellId = (cellStorage.getStore() ?? activeCell)?.cellId ?? "";
	return new Promise((resolve, reject) => {
		pendingHostRequests.set(id, { cellId, resolve, reject });
		send({ type: "host_request", id, cellId, requestType, payload });
	});
}

/**
 * Bun.$ interpolates values into the command string, and `String(undefined)` is
 * the literal text "undefined". A single stale variable therefore turns
 * `rm -rf ${dir}` into `rm -rf undefined` — a command that runs, succeeds, and
 * operates on entirely the wrong path. The shell cannot distinguish a missing
 * value from one that is genuinely the word "undefined", so it is refused here,
 * before the command is ever built.
 */
function guardShellInterpolation(shell: typeof Bun.$): typeof Bun.$ {
	return new Proxy(shell, {
		apply(target, thisArg, args: unknown[]) {
			const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
			for (let i = 0; i < values.length; i++) {
				if (values[i] === null || values[i] === undefined) {
					const preceding = (strings?.[i] ?? "").trimStart().slice(-40);
					const where = preceding ? ` (after "…${preceding}")` : "";
					throw new TypeError(
						`Bun.$ interpolation #${i + 1}${where} is ${values[i] === null ? "null" : "undefined"}. ` +
							`It would be interpolated as the literal text "${String(values[i])}", producing a command that runs ` +
							"against the wrong target. Check the value before using it in a shell command.",
					);
				}
			}
			return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
		},
	});
}

const GUARDED_SHELL = guardShellInterpolation(Bun.$);

const GUARDED_BUN = new Proxy(Bun, {
	get(target, key) {
		if (key === "$") return GUARDED_SHELL;
		// Bind the receiver to the real Bun so its methods keep their own `this`.
		return Reflect.get(target, key, target);
	},
});

/**
 * Host-mounted pi tools. The list is fixed by the host adapter; `call` exists
 * for forward compatibility and gets the same teaching errors for unknown
 * names. Each method resolves to { text, images, details } — text is the
 * joined text blocks, images counts blocks the host forwards into the cell's
 * result so the model can see them.
 */
const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

interface ToolReply extends Record<string, unknown> {
	text: string;
	images: number;
	details: unknown;
	/** tools.read only: content without trailing bracketed reader notices. */
	raw?: string;
}

const TOOLS_HANDLE: Record<string, unknown> = {
	async call(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
		return (await hostRequest("tools.call", { name, args })) as ToolReply;
	},
};
for (const name of TOOL_NAMES) {
	TOOLS_HANDLE[name] = async (args: Record<string, unknown> = {}): Promise<ToolReply> =>
		(await hostRequest("tools.call", { name, args })) as ToolReply;
}

const RLM_HANDLE = {
	hostRequest,
	async run(prompt: string, kwargs: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return hostRequest("rlm.run", { prompt, kwargs });
	},
	async listSubagents(): Promise<Record<string, unknown>> {
		return hostRequest("rlm.list_subagents", {});
	},
	async deleteSubagent(target: string): Promise<Record<string, unknown>> {
		return hostRequest("rlm.delete_subagent", { target });
	},
};

/** Names owned by the engine; snapshot skips them while they hold the live value. */
const INTERNAL_BINDINGS = new Map<string, unknown>();

function installBootstrapBindings(): void {
	namespace.rlm = RLM_HANDLE;
	INTERNAL_BINDINGS.set("rlm", RLM_HANDLE);
	// Cells resolve `Bun` through the namespace, so this shadows the global with
	// a version whose shell refuses nullish interpolation.
	namespace.Bun = GUARDED_BUN;
	INTERNAL_BINDINGS.set("Bun", GUARDED_BUN);
	namespace.tools = TOOLS_HANDLE;
	INTERNAL_BINDINGS.set("tools", TOOLS_HANDLE);
}

installBootstrapBindings();

// ── cell execution ───────────────────────────────────────────────────────────

const AsyncFunction = (async () => {}).constructor as new (
	...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

const liveCells = new Map<string, CellContext>();

async function runCell(cellId: string, code: string): Promise<void> {
	const ctx = makeCellContext(cellId);
	activeCell = ctx;
	liveCells.set(cellId, ctx);

	let done: GuestToHostMessage;
	try {
		const { body } = transformCell(code, { ctxName: CTX_NAME });
		// Sloppy-mode wrapper so `with` is legal; async for top-level await.
		const wrapper = new AsyncFunction(SCOPE_NAME, CTX_NAME, `with (${SCOPE_NAME}) { ${body}\n }`);
		await cellStorage.run(ctx, () => wrapper(makeScopeProxy(ctx), ctx));
		done = {
			type: "done",
			cellId,
			status: ctx.aborted ? "aborted" : "ok",
			result: !ctx.aborted && ctx.result && ctx.result.value !== undefined ? Bun.inspect(ctx.result.value) : undefined,
		};
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		done = {
			type: "done",
			cellId,
			status: ctx.aborted ? "aborted" : "error",
			error: { name: err.name, message: err.message, stack: (err.stack ?? "").split("\n") },
		};
	} finally {
		if (activeCell === ctx) activeCell = undefined;
		liveCells.delete(cellId);
	}
	send(done);
}

function abortCell(cellId: string): void {
	const ctx = liveCells.get(cellId);
	if (ctx) ctx.aborted = true;
	// Reject whatever this cell is waiting on at the bridge. The host stops
	// caring about a cancelled cell after a short grace period, so nothing else
	// will ever settle these: without this the cell stays suspended inside the
	// evaluator for the life of the process, holding its continuation and its
	// pending entry, and those accumulate across a long session.
	for (const [id, pending] of [...pendingHostRequests]) {
		if (pending.cellId !== cellId) continue;
		pendingHostRequests.delete(id);
		pending.reject(new Error("the cell that issued this host request was cancelled"));
	}
}

// ── snapshot / restore / names ───────────────────────────────────────────────

function snapshotNamespace(): { vars: Record<string, string>; failed: { name: string; reason: string }[] } {
	const vars: Record<string, string> = {};
	const failed: { name: string; reason: string }[] = [];
	for (const [name, value] of Object.entries(namespace)) {
		if (INTERNAL_BINDINGS.get(name) === value) continue;
		try {
			vars[name] = Buffer.from(serialize(value)).toString("base64");
		} catch (error) {
			failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { vars, failed };
}

function restoreNamespace(vars: Record<string, string>): {
	restored: string[];
	failed: { name: string; reason: string }[];
} {
	const restored: string[] = [];
	const failed: { name: string; reason: string }[] = [];
	for (const [name, encoded] of Object.entries(vars)) {
		try {
			const buffer = Buffer.from(encoded, "base64");
			namespace[name] = deserialize(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
			restored.push(name);
		} catch (error) {
			failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	// Bootstrap runs after restore: live handles overwrite anything revived.
	installBootstrapBindings();
	return { restored, failed };
}

function listNames(): string[] {
	return Object.keys(namespace).filter((name) => INTERNAL_BINDINGS.get(name) !== namespace[name]);
}

// ── resilience ───────────────────────────────────────────────────────────────
// A throw from a detached task (setTimeout, a floating promise) would otherwise
// kill the process and take the whole namespace with it. Report it as stderr on
// the owning cell and keep the evaluator alive.

function reportStrayError(kind: string, error: unknown): void {
	const err = error instanceof Error ? error : new Error(String(error));
	emit("stderr", `[${kind}] ${err.name}: ${err.message}\n`);
}

process.on("uncaughtException", (error) => reportStrayError("uncaught exception", error));
process.on("unhandledRejection", (reason) => reportStrayError("unhandled rejection", reason));

// ── message loop ─────────────────────────────────────────────────────────────

const readline = createInterface({ input: process.stdin });

readline.on("line", (line) => {
	const message = decodeMessage<HostToGuestMessage>(line, NONCE);
	if (!message) return;
	switch (message.type) {
		case "run":
			void runCell(message.cellId, message.code);
			break;
		case "abort":
			abortCell(message.cellId);
			break;
		case "ping":
			send({ type: "pong", id: message.id });
			break;
		case "host_reply": {
			const pending = pendingHostRequests.get(message.id);
			if (!pending) break;
			pendingHostRequests.delete(message.id);
			if (message.status === "ok") pending.resolve(message.payload ?? {});
			else pending.reject(new Error(message.error ?? "host request failed"));
			break;
		}
		case "snapshot": {
			const { vars, failed } = snapshotNamespace();
			send({ type: "snapshot_result", id: message.id, vars, failed });
			break;
		}
		case "restore": {
			const { restored, failed } = restoreNamespace(message.vars);
			send({ type: "restore_result", id: message.id, restored, failed });
			break;
		}
		case "list_names":
			send({ type: "names_result", id: message.id, names: listNames() });
			break;
	}
});

readline.on("close", () => {
	try {
		writeSync(2, "[guest] stdin closed; exiting\n");
	} catch {}
	process.exit(0);
});

send({ type: "ready" });
