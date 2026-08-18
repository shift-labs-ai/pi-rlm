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
 * Protocol traffic travels on fd 3 — both directions — and carries a nonce, so
 * cell output can be neither mistaken for nor forged into a protocol message.
 * stdin is /dev/null: subprocesses spawned by cells inherit this process's
 * fd 0, and if it were the host's command pipe (which never closes), anything
 * reading stdin would hang forever waiting for EOF.
 *
 * Runs as: bun guest.ts   (spawned by EngineManager)
 */

import { deserialize, serialize } from "bun:jsc";
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { format } from "node:util";
import { importNpm } from "./npm.js";
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

// ── namespace economy ────────────────────────────────────────────────────────
// Long sessions accumulate state faster than they shed it. Three structures
// keep the cost proportional to what is actually being used:
//   - nameMeta records when each name was last touched (read or written), in
//     cell counts. Reads count as touches because interior mutation
//     (`arr.push(1)`) is only visible as a read of `arr` — treating reads as
//     clean would let a mutated value ride a stale cached blob into a snapshot.
//   - blobCache holds each name's last serialized form so a snapshot only
//     re-serialises names touched since it was cached.
//   - deferredBlobs holds values revived from a snapshot but not yet
//     deserialized: large cold values load on first read instead of eagerly.
//     Nothing in here is ever dropped by the engine; only rlm.forget removes.

/** Monotonic cell counter; restored from the snapshot so ages span restarts. */
let cellSeq = 0;
const nameMeta = new Map<string, number>();
const blobCache = new Map<string, { b64: string; serializedAt: number }>();
const deferredBlobs = new Map<string, { b64: string; touchedAt: number }>();

function touchName(name: string): void {
	nameMeta.set(name, cellSeq);
}

/** Deserialize a deferred value into the namespace. Sync so a plain read works. */
function loadDeferred(name: string, entry: { b64: string; touchedAt: number }): unknown {
	let value: unknown;
	try {
		const buffer = Buffer.from(entry.b64, "base64");
		value = deserialize(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`variable "${name}" could not be reloaded from the snapshot: ${reason}`);
	}
	deferredBlobs.delete(name);
	namespace[name] = value;
	touchName(name);
	emit("stderr", `[loaded "${name}" from the namespace snapshot]\n`);
	return value;
}

/** Remove names entirely: namespace, caches, deferred storage, future snapshots. */
function forgetNames(names: string[]): string[] {
	const removed: string[] = [];
	for (const name of names) {
		if (typeof name !== "string") continue;
		const existed = name in namespace || deferredBlobs.has(name);
		delete namespace[name];
		deferredBlobs.delete(name);
		blobCache.delete(name);
		nameMeta.delete(name);
		if (existed) removed.push(name);
	}
	return removed;
}

interface CellContext {
	cellId: string;
	/** Set when this cell is aborted; its later writes are discarded. */
	aborted: boolean;
	result?: { value: unknown };
	setResult(value: unknown): void;
	/** Import an npm: specifier via the lazy cache; targeted by the transform. */
	importModule(specifier: string): Promise<unknown>;
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
		importModule(specifier: string) {
			return importNpm(specifier);
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
			if (key in target) {
				touchName(key);
				return target[key];
			}
			const deferred = deferredBlobs.get(key);
			if (deferred) return loadDeferred(key, deferred);
			return (globalThis as Record<string, unknown>)[key];
		},
		set(target, key, value) {
			// Writes from an aborted cell's orphaned continuation are dropped;
			// writes from cells that are merely older are not.
			if (typeof key === "string" && !ctx.aborted) {
				// Overwriting a deferred name supersedes its stored blob entirely.
				deferredBlobs.delete(key);
				target[key] = value;
				touchName(key);
			}
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
		try {
			send({ type: "host_request", id, cellId, requestType, payload });
		} catch (error) {
			// A payload the protocol cannot encode (BigInt, circular) throws here,
			// after the pending entry was registered. The throw correctly fails
			// the caller, but the entry must not outlive it — nothing will ever
			// reply to a request that was never sent.
			pendingHostRequests.delete(id);
			throw error;
		}
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
	/**
	 * The only true deletion in the namespace economy: the engine defers and
	 * caches but never destroys, so removal is an explicit agent decision.
	 *
	 * Refused for an aborted cell's orphaned continuation for the same reason
	 * the namespace proxy refuses its writes — forget bypasses the proxy, and
	 * state destroyed by a cell the agent believes it stopped is worse than
	 * either finishing or failing cleanly.
	 */
	forget(...names: string[]): string[] {
		const owner = cellStorage.getStore() ?? activeCell;
		if (owner?.aborted) return [];
		return forgetNames(names);
	},
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
	cellSeq += 1;
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

function snapshotNamespace(): {
	vars: Record<string, string>;
	written: string[];
	meta: Record<string, { touchedAt: number }>;
	cellSeq: number;
	failed: { name: string; reason: string }[];
} {
	const vars: Record<string, string> = {};
	const written: string[] = [];
	const meta: Record<string, { touchedAt: number }> = {};
	const failed: { name: string; reason: string }[] = [];
	for (const [name, value] of Object.entries(namespace)) {
		if (INTERNAL_BINDINGS.get(name) === value) continue;
		const touchedAt = nameMeta.get(name) ?? cellSeq;
		const cached = blobCache.get(name);
		if (cached && cached.serializedAt >= touchedAt) {
			// Untouched since it was last serialized — reuse the cached blob so
			// snapshot cost tracks the live set, not the session's whole history.
			vars[name] = cached.b64;
		} else {
			try {
				const b64 = Buffer.from(serialize(value)).toString("base64");
				vars[name] = b64;
				written.push(name);
				blobCache.set(name, { b64, serializedAt: cellSeq });
			} catch (error) {
				failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
				continue;
			}
		}
		meta[name] = { touchedAt };
	}
	// Deferred values were never deserialized; their blobs pass through intact
	// with their original ages, so an unread value survives any number of
	// snapshot/restore cycles.
	for (const [name, entry] of deferredBlobs) {
		vars[name] = entry.b64;
		meta[name] = { touchedAt: entry.touchedAt };
	}
	return { vars, written, meta, cellSeq, failed };
}

function restoreNamespace(
	vars: Record<string, string>,
	meta: Record<string, { touchedAt: number }> = {},
	snapshotSeq = 0,
	defer?: { minBytes: number; minAgeCells: number },
): {
	restored: string[];
	deferred: string[];
	failed: { name: string; reason: string }[];
} {
	const restored: string[] = [];
	const deferred: string[] = [];
	const failed: { name: string; reason: string }[] = [];
	// Ages continue from where the snapshotted session stopped counting.
	cellSeq = Math.max(cellSeq, snapshotSeq);
	for (const [name, encoded] of Object.entries(vars)) {
		const touchedAt = meta[name]?.touchedAt ?? snapshotSeq;
		// A name that already exists stays on the eager path regardless of size:
		// restore has always meant "the snapshot value overwrites", and a deferred
		// blob behind a live name would be shadowed on reads yet still written
		// over the live value by the next snapshot's deferred pass — stale data
		// silently persisted. Deferral is only safe for names nothing holds.
		if (
			defer &&
			!(name in namespace) &&
			encoded.length >= defer.minBytes &&
			snapshotSeq - touchedAt >= defer.minAgeCells
		) {
			// Large and cold: keep the blob, skip the deserialize. The proxy's get
			// trap loads it the first time the agent reads the name.
			deferredBlobs.set(name, { b64: encoded, touchedAt });
			nameMeta.set(name, touchedAt);
			deferred.push(name);
			continue;
		}
		try {
			const buffer = Buffer.from(encoded, "base64");
			namespace[name] = deserialize(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
			restored.push(name);
			nameMeta.set(name, touchedAt);
			// The blob is valid until the name is touched again; reviving must not
			// force the next snapshot to re-serialise the entire namespace.
			blobCache.set(name, { b64: encoded, serializedAt: touchedAt });
		} catch (error) {
			failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	// Bootstrap runs after restore: live handles overwrite anything revived.
	installBootstrapBindings();
	return { restored, deferred, failed };
}

function listNames(): string[] {
	const names = Object.keys(namespace).filter((name) => INTERNAL_BINDINGS.get(name) !== namespace[name]);
	// Deferred names are part of the namespace the agent can read; hiding them
	// here would misreport what a cell can reach.
	return [...names, ...deferredBlobs.keys()];
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

// Commands arrive on the same duplex fd the replies leave on. Reading and
// writing are independent directions of the socketpair, so the sync writes in
// send() do not interfere with this stream. The empty path is ignored when an
// fd is supplied; it only satisfies the signature.
const readline = createInterface({ input: createReadStream("", { fd: PROTOCOL_FD }) });

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
			const { vars, written, meta, cellSeq: seq, failed } = snapshotNamespace();
			send({ type: "snapshot_result", id: message.id, vars, written, meta, cellSeq: seq, failed });
			break;
		}
		case "restore": {
			const { restored, deferred, failed } = restoreNamespace(
				message.vars,
				message.meta,
				message.cellSeq,
				message.defer,
			);
			send({ type: "restore_result", id: message.id, restored, deferred, failed });
			break;
		}
		case "list_names":
			send({ type: "names_result", id: message.id, names: listNames() });
			break;
	}
});

readline.on("close", () => {
	// The host holds the other end of this pipe; EOF here means the host is
	// gone, even if it died too abruptly to kill this process.
	try {
		writeSync(2, "[guest] protocol pipe closed; exiting\n");
	} catch {}
	process.exit(0);
});

send({ type: "ready" });
