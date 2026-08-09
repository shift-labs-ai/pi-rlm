/**
 * EngineManager — the host half of the evaluator.
 *
 * Owns one persistent Bun guest process, speaks the line-JSON protocol over a
 * private pipe, and exposes the execute / snapshot / restore API the `execute`
 * tool is built on.
 *
 * The guarantees it is responsible for:
 *   - one cell runs at a time, in submission order;
 *   - output is attributed to the cell that produced it, and stops the moment
 *     that cell is cancelled;
 *   - the namespace outlives errors, cancellation, and session resume.
 *
 * ARCHITECTURE.md explains how these are achieved and why they matter.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	decodeMessage,
	encodeMessage,
	type GuestToHostMessage,
	type HostToGuestMessage,
	NONCE_ENV,
	PROTOCOL_FD,
} from "./protocol.js";

const GUEST_PATH = fileURLToPath(new URL("./guest.ts", import.meta.url));
const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const READY_TIMEOUT_MS = 10_000;
const ABORT_GRACE_MS = 500;
const PING_TIMEOUT_MS = 5_000;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How many recent cells stay resolvable for late bridge calls.
 *
 * A cancelled cell's continuation can reach the bridge long after the host has
 * settled it, and that request still needs its own signal and source. Keeping
 * the records bounded means an orphan stays attributable for a while without
 * the map growing for the life of the session.
 */
const MAX_CELL_RECORDS = 64;

export interface EngineExecuteError {
	/** Error class name, e.g. "TypeError". */
	name: string;
	message: string;
	/** Stack trace, split into lines. */
	stack: string[];
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Rendered value of the cell's final expression, when it has one. */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: EngineExecuteError;
	durationMs: number;
}

export interface ExecuteOptions {
	/** Aborting cancels the cell cooperatively; namespace is preserved. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
}

/** Passed alongside a host request's payload. */
export interface HostRequestContext {
	/**
	 * Aborts when the cell that issued this request is cancelled, or when that
	 * cell settles for any other reason — work outliving its cell is orphaned.
	 *
	 * Always present. A request whose cell is too old to still be tracked
	 * arrives already aborted rather than without a signal, so a handler never
	 * has to decide what an absent signal means.
	 */
	signal: AbortSignal;
}

/** Handles one typed request from guest code. Reply is sent back verbatim. */
export type HostRequestHandler = (
	payload: Record<string, unknown>,
	context?: HostRequestContext,
) => Promise<Record<string, unknown>>;
export type HostRequestHandlers = Record<string, HostRequestHandler>;

export interface SnapshotResult {
	path: string;
	/** Top-level names successfully serialized. */
	saved: string[];
	/** Names that could not be serialized, with reasons. */
	failed: { name: string; reason: string }[];
}

export interface RestoreResult {
	path: string;
	restored: string[];
	failed: { name: string; reason: string }[];
}

export interface EngineOptions {
	cwd?: string;
	env?: Record<string, string>;
	hostHandlers?: HostRequestHandlers;
	/** Persist/revive the namespace across engine restarts. */
	snapshot?: {
		path: string;
		/** Debounce for the auto-snapshot after each ok cell. Default 1500 ms. */
		debounceMs?: number;
	};
}

/**
 * Thrown by execute() when a cancelled cell is still occupying the evaluator.
 *
 * Cancellation is cooperative, so a cell spinning in synchronous code never
 * yields and no later cell can run. The engine cannot resolve this on its own;
 * the caller recovers by killing the engine and starting a fresh one, whose
 * restoreState() brings the last snapshotted namespace back.
 */
export class EngineBusyError extends Error {
	constructor() {
		super("Engine is still running the previously interrupted cell. Kill the engine to start fresh.");
		this.name = "EngineBusyError";
	}
}

interface ActiveExecution {
	cellId: string;
	code: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	error?: EngineExecuteError;
	status: ExecuteResult["status"];
	settled: boolean;
	/** Set on cancellation: a cancelled cell must stop contributing output at once. */
	abortRequested: boolean;
	/** Aborts host-side work done on this cell's behalf (bridged tool calls). */
	hostAbort: AbortController;
	resolve(result: ExecuteResult): void;
	reject(error: Error): void;
}

// ── process-wide cleanup ─────────────────────────────────────────────────────
// Guests are killed when the host exits normally. As a backstop the guest also
// self-exits when its stdin reaches EOF, which covers a host death abrupt
// enough that no handler runs.

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

interface PendingRequest {
	resolve(message: GuestToHostMessage): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean): string {
	if (!wasTruncated && text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private child?: ChildProcess;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	/** Per-process protocol nonce; also names the guest's internal bindings. */
	private readonly nonce = randomUUID().replaceAll("-", "");
	/** Tail of the guest's own stderr, surfaced when it dies unexpectedly. */
	private guestStderr = "";
	/** Resolves when the child and all of its stdio have fully closed. */
	private childClosed?: Promise<void>;
	/** Held so the protocol reader is not garbage-collected mid-session, which
	 * would close the guest's write end and kill it with EPIPE. */
	private protocolReader?: ReturnType<typeof createInterface>;
	/** Abort + source per cell, retained past settlement for late bridge calls. */
	private readonly cellRecords = new Map<string, { hostAbort: AbortController; code: string }>();
	/** Set when an aborted cell may still be wedging the guest's event loop. */
	private maybeWedged = false;
	private snapshotTimer?: ReturnType<typeof setTimeout>;

	constructor(options: EngineOptions = {}) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.state === "running";
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.state === "shutdown") throw new Error("Engine has been shut down");
		if (!this.startPromise) {
			const startup = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
			// Callers await the rejection; this guard keeps a startup failure that
			// nobody is waiting on from surfacing as an unhandled rejection.
			startup.catch(() => {});
			this.startPromise = startup;
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.state = "starting";
		installProcessCleanupOnce();
		liveEngines.add(this);
		const child = spawn("bun", ["run", GUEST_PATH], {
			cwd: this.options.cwd,
			env: {
				...process.env,
				...(this.options.env ?? {}),
				[NONCE_ENV]: this.nonce,
			},
			// fd 3 carries protocol traffic so stdout/stderr stay pure user output.
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.childClosed = new Promise((resolve) => child.once("close", () => resolve()));

		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Engine guest did not become ready in time")), READY_TIMEOUT_MS);
			timer.unref?.();
			this.pendingRequests.set("__ready__", {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});

		const protocolStream = child.stdio[PROTOCOL_FD] as NodeJS.ReadableStream | null;
		if (!protocolStream) {
			throw new Error("Engine guest was spawned without a protocol pipe on fd 3");
		}
		this.protocolReader = createInterface({ input: protocolStream });
		this.protocolReader.on("line", (line) => this.handleGuestLine(line));
		// Anything the guest writes to the real stdout/stderr fds is subprocess
		// output (Bun.$ without .quiet()); attribute it to the running cell.
		child.stdout!.on("data", (buffer: Buffer) => this.appendActiveOutput("stdout", buffer.toString()));
		child.stderr!.on("data", (buffer: Buffer) => {
			const text = buffer.toString();
			this.guestStderr = (this.guestStderr + text).slice(-4000);
			this.appendActiveOutput("stderr", text);
		});

		child.on("error", (error) => {
			// pi runs on Node, but the evaluator is a Bun process. When bun is not
			// installed the raw ENOENT names a file nobody went looking for, so say
			// what is actually missing and how to get it.
			const message =
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "Engine process failed: 'bun' was not found on PATH. pi-rlm runs its evaluator in Bun; install it from https://bun.sh and restart pi."
					: `Engine process failed: ${error.message}`;
			this.failAllPending(new Error(message));
			this.transitionToShutdown(message);
		});
		child.on("exit", (code, signal) => {
			// A killed child's exit event arrives after teardown has already moved
			// on. Acting on it would reject an execution nobody is waiting for any
			// more, surfacing as an unhandled rejection in an unrelated context.
			if (this.child !== child) return;
			if (this.state !== "shutdown") {
				const tail = this.guestStderr.trim();
				const reason =
					`Engine process exited unexpectedly (code=${code} signal=${signal})` +
					(tail ? `\nguest stderr:\n${tail.slice(-1500)}` : "");
				this.failAllPending(new Error(reason));
				this.transitionToShutdown(reason);
			}
		});

		await ready;
		// Being torn down while starting wins: without this the late assignment
		// resurrects a killed engine as "running", and the child's own exit event
		// then reads that as an unexpected death.
		if ((this.state as string) === "shutdown") throw new Error("Engine has been shut down");
		this.state = "running";
	}

	private transitionToShutdown(reason: string): void {
		this.state = "shutdown";
		this.clearSnapshotTimer();
		const active = this.activeExecution;
		if (active && !active.settled) {
			this.activeExecution = undefined;
			active.settled = true;
			active.reject(new Error(reason));
		}
	}

	private failAllPending(error: Error): void {
		for (const [, pending] of this.pendingRequests) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	async kill(): Promise<void> {
		const closed = this.childClosed;
		this.killSync();
		// Teardown is not done until the child's stdio is actually closed. A
		// SIGKILL'd child's pipes are torn down asynchronously, and a spawn that
		// follows too quickly recycles those descriptors while the teardown is
		// still in flight - which can close a pipe belonging to the new engine.
		// Observed as a fresh guest hitting EPIPE on its first protocol write.
		if (closed) {
			await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())]);
		}
	}

	/** Synchronous teardown, safe from process.on("exit"). */
	killSync(): void {
		this.clearSnapshotTimer();
		const active = this.activeExecution;
		if (active && !active.settled) {
			active.status = "aborted";
			this.settleActiveExecution(active);
		}
		this.state = "shutdown";
		liveEngines.delete(this);
		this.failAllPending(new Error("Engine has been shut down"));
		this.child?.kill("SIGKILL");
		this.child = undefined;
		this.protocolReader?.close();
		this.protocolReader = undefined;
	}

	/** Graceful cleanup: flush a final snapshot, then terminate the guest. */
	async dispose(): Promise<void> {
		if (this.state === "running") {
			await this.snapshotState().catch(() => null);
		}
		await this.kill();
	}

	// ── guest messaging ────────────────────────────────────────────────────────

	private sendToGuest(message: HostToGuestMessage): void {
		// A write into a dying child's stdin can throw synchronously. A dead pipe
		// here only ever means "engine gone", which every caller already learns
		// through the exit path — a late host reply must not become an unhandled
		// rejection inside dispatchHostRequest's own error handler.
		try {
			this.child?.stdin?.write(encodeMessage(message, this.nonce));
		} catch {}
	}

	private request(message: HostToGuestMessage & { id: string }, timeoutMs: number): Promise<GuestToHostMessage> {
		const pending = new Promise<GuestToHostMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(message.id);
				reject(new Error(`Engine request ${message.type} timed out`));
			}, timeoutMs);
			timer.unref?.();
			this.pendingRequests.set(message.id, { resolve, reject, timer });
			this.sendToGuest(message);
		});
		// Teardown rejects every outstanding request. A caller that has already
		// moved on is no longer listening, and that rejection would otherwise
		// escape as an unhandled rejection in whatever happens to be running.
		// Marking it handled here does not hide anything from the real caller,
		// which still receives the rejection through the returned promise.
		pending.catch(() => {});
		return pending;
	}

	private handleGuestLine(line: string): void {
		// fd 3 carries only protocol traffic; a line that fails to decode (wrong
		// nonce, malformed) is discarded rather than shown as output.
		const message = decodeMessage<GuestToHostMessage>(line, this.nonce);
		if (!message) return;
		switch (message.type) {
			case "ready": {
				const pending = this.pendingRequests.get("__ready__");
				if (pending) {
					this.pendingRequests.delete("__ready__");
					pending.resolve(message);
				}
				break;
			}
			case "stream": {
				const active = this.activeExecution;
				// Untagged output belongs to no cell; attributing it to whichever cell
				// is active is the same class of bug as the orphan leak.
				if (!active || active.settled || message.cellId !== active.cellId) return;
				this.appendOutput(active, message.name, message.chunk);
				break;
			}
			case "done": {
				const active = this.activeExecution;
				if (!active || active.settled || active.cellId !== message.cellId) return;
				if (message.status === "error") {
					active.status = "error";
					active.error = message.error;
				} else if (message.status === "aborted") {
					active.status = "aborted";
				} else {
					active.result = message.result;
				}
				this.settleActiveExecution(active);
				break;
			}
			case "pong": {
				this.resolveRequest(message.id, message);
				break;
			}
			case "snapshot_result":
			case "restore_result":
			case "names_result": {
				this.resolveRequest(message.id, message);
				break;
			}
			case "host_request": {
				void this.dispatchHostRequest(message.id, message.cellId, message.requestType, message.payload);
				break;
			}
		}
	}

	private resolveRequest(id: string, message: GuestToHostMessage): void {
		const pending = this.pendingRequests.get(id);
		if (!pending) return;
		this.pendingRequests.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(message);
	}

	private async dispatchHostRequest(
		id: string,
		cellId: string,
		requestType: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		try {
			const handler = this.options.hostHandlers?.[requestType];
			if (!handler) {
				throw new Error(`host request type "${requestType}" is not available in this session`);
			}
			// Attribute the request to the cell that issued it, and hand it that
			// cell's abort signal so host-side work (a bridged bash call, a
			// subprocess) stops when the cell does.
			//
			// Resolving either from activeExecution would be wrong for the case that
			// matters most: a cancelled cell is force-settled after ABORT_GRACE_MS,
			// but its continuation keeps running and can still call the bridge. By
			// then activeExecution is undefined or belongs to a different cell, so
			// the request would be attributed to a program that never asked for it
			// and given no signal at all - host work spawned by a cell the agent has
			// already cancelled, which nothing can then cancel.
			const record = this.cellRecords.get(cellId);
			// A cell we no longer have a record for is old enough to be an orphan.
			// Refusing to grant an open-ended signal is the safe reading, and the
			// source is reported as unknown rather than guessed: naming the most
			// recent cell instead would be the same misattribution this exists to
			// prevent, only harder to notice because it looks like an answer.
			const signal = record ? record.hostAbort.signal : AbortSignal.abort();
			const reply = await handler({ ...payload, cellSourceCode: record?.code }, { signal });
			this.sendToGuest({ type: "host_reply", id, status: "ok", payload: reply });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendToGuest({ type: "host_reply", id, status: "error", error: message });
		}
	}

	private rememberCell(cellId: string, hostAbort: AbortController, code: string): void {
		this.cellRecords.set(cellId, { hostAbort, code });
		// Map iteration is insertion-ordered, so the oldest record is the first key.
		while (this.cellRecords.size > MAX_CELL_RECORDS) {
			const oldest = this.cellRecords.keys().next().value;
			if (oldest === undefined) break;
			this.cellRecords.delete(oldest);
		}
	}

	// ── output accumulation ────────────────────────────────────────────────────

	private appendActiveOutput(name: "stdout" | "stderr", text: string): void {
		const active = this.activeExecution;
		if (!active || active.settled) return;
		this.appendOutput(active, name, text);
	}

	private appendOutput(active: ActiveExecution, name: "stdout" | "stderr", text: string): void {
		if (active.abortRequested) return;
		const key = name === "stdout" ? "stdout" : "stderr";
		const truncatedKey = name === "stdout" ? "stdoutTruncated" : "stderrTruncated";
		if (active[key].length < active.maxChars) {
			active[key] += text;
			if (active[key].length > active.maxChars) {
				active[key] = active[key].slice(0, active.maxChars);
				active[truncatedKey] = true;
			}
		} else {
			active[truncatedKey] = true;
		}
		active.opts.onStream?.(text, name);
	}

	// ── execute ────────────────────────────────────────────────────────────────

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		// Claim the queue slot synchronously, before the first await, so that
		// submission order is execution order for concurrent callers.
		const previous = this.executionQueue;
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}
			if (this.state === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			await this.start();
			if ((this.state as string) === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			if (this.maybeWedged) {
				await this.assertGuestResponsive();
			}
			const result = await this.executeInner(code, opts);
			if (result.status === "ok") this.scheduleSnapshot();
			return result;
		} finally {
			release();
		}
	}

	private async assertGuestResponsive(): Promise<void> {
		try {
			await this.request({ type: "ping", id: randomUUID() }, PING_TIMEOUT_MS);
			this.maybeWedged = false;
		} catch (error) {
			if (this.state === "shutdown" || !this.child) {
				throw new Error("Engine has been shut down");
			}
			void error;
			throw new EngineBusyError();
		}
	}

	private executeInner(code: string, opts: ExecuteOptions): Promise<ExecuteResult> {
		const cellId = randomUUID();
		const started = Date.now();

		return new Promise<ExecuteResult>((resolve, reject) => {
			const active: ActiveExecution = {
				cellId,
				code,
				started,
				maxChars: opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
				opts,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				status: "ok",
				settled: false,
				abortRequested: false,
				hostAbort: new AbortController(),
				resolve,
				reject,
			};
			this.activeExecution = active;
			this.rememberCell(cellId, active.hostAbort, code);

			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				active.abortRequested = true;
				active.hostAbort.abort();
				this.sendToGuest({ type: "abort", cellId });
				this.maybeWedged = true;
				graceTimer = setTimeout(() => {
					if (this.activeExecution === active && !active.settled) {
						active.status = "aborted";
						this.settleActiveExecution(active);
					}
				}, ABORT_GRACE_MS);
				graceTimer.unref?.();
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			const originalResolve = active.resolve;
			active.resolve = (result) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalResolve(result);
			};
			const originalReject = active.reject;
			active.reject = (error) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalReject(error);
			};

			this.sendToGuest({ type: "run", cellId, code });
		});
	}

	private settleActiveExecution(active: ActiveExecution): void {
		if (active.settled) return;
		active.settled = true;
		if (this.activeExecution === active) this.activeExecution = undefined;
		// The cell is over, so any host work still running on its behalf is
		// orphaned. Firing the signal here means a late bridge call sees an
		// already-cancelled cell rather than an open-ended one.
		active.hostAbort.abort();

		// A cancelled cell reports "aborted" even if it happened to finish first:
		// the caller withdrew interest, so the value is not theirs to consume.
		let status = active.status;
		if (active.opts.signal?.aborted) status = "aborted";
		if (status !== "aborted") this.maybeWedged = false;

		const stdout = truncateWithMarker(active.stdout, active.maxChars, active.stdoutTruncated);
		const stderr = truncateWithMarker(active.stderr, active.maxChars, active.stderrTruncated);
		let result = active.result;
		if (result !== undefined && result.length > active.maxChars) {
			result = truncateWithMarker(result, active.maxChars, true);
		}

		active.resolve({
			stdout,
			stderr,
			result,
			error: active.error,
			status,
			durationMs: Date.now() - active.started,
		});
	}

	// ── snapshot / restore / names ─────────────────────────────────────────────

	async snapshotState(): Promise<SnapshotResult | null> {
		const config = this.options.snapshot;
		if (!config || this.state !== "running") return null;
		try {
			const reply = await this.request({ type: "snapshot", id: randomUUID() }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "snapshot_result") return null;
			mkdirSync(dirname(config.path), { recursive: true });
			writeFileSync(config.path, JSON.stringify({ version: 1, vars: reply.vars, failed: reply.failed }));
			return { path: config.path, saved: Object.keys(reply.vars), failed: reply.failed };
		} catch {
			return null;
		}
	}

	async restoreState(): Promise<RestoreResult | null> {
		const config = this.options.snapshot;
		if (!config) return null;
		if (!existsSync(config.path)) return null;
		await this.start();
		try {
			const payload = JSON.parse(readFileSync(config.path, "utf8")) as {
				vars?: Record<string, string>;
			};
			const vars = payload.vars ?? {};
			const reply = await this.request({ type: "restore", id: randomUUID(), vars }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "restore_result") return null;
			return { path: config.path, restored: reply.restored, failed: reply.failed };
		} catch {
			return null;
		}
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running") return null;
		try {
			const reply = await this.request({ type: "list_names", id: randomUUID() }, PING_TIMEOUT_MS);
			return reply.type === "names_result" ? reply.names : null;
		} catch {
			return null;
		}
	}

	private scheduleSnapshot(): void {
		const config = this.options.snapshot;
		if (!config) return;
		this.clearSnapshotTimer();
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.snapshotState();
		}, config.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		this.snapshotTimer.unref?.();
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}
}
