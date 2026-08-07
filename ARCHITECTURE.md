# Architecture

## Shape

Two processes. The host lives inside pi; the guest owns the namespace.

```
pi
 └─ extension            registers the execute tool, owns the session wiring
     └─ EngineManager    lifecycle, execution queue, output accounting, snapshots
         │  stdin   ──▶  commands
         │  fd 3    ◀──  protocol: results, output, host requests
         │  stdout  ◀──  subprocess output only
         └─ guest (bun)  namespace, cell execution, host bridge
```

Splitting them is what makes the evaluator survivable. A cell can wedge the
guest, exhaust its memory, or kill it outright without taking pi down, and the
host can always report what happened because it is not the thing that failed.

## A cell, end to end

1. The tool hands `EngineManager.execute` the cell source.
2. The manager claims the execution slot **synchronously**, before its first
   await, so concurrent callers run in submission order rather than in whatever
   order their startup happened to finish.
3. The guest transforms the source: types stripped, top-level declarations
   rewritten to assignments, imports rewritten to awaited dynamic imports (with
   static `npm:` imports routed through the lazy Bun cache importer), and a
   trailing expression captured as the result.
4. The body runs inside `with (proxy)` in an async function. Ordinary
   assignments become namespace entries; ordinary reads resolve against the
   namespace, then the global scope.
5. Output is tagged with the cell that produced it and streamed to the host as
   it happens.
6. The guest reports completion. The host applies output caps, decides the final
   status, and schedules a snapshot if the cell succeeded.

## Invariants

These are the promises the engine makes. Each is pinned by a test in
`test/engine.contract.test.ts`.

**One cell at a time, in submission order.** There is one namespace; interleaved
cells would make results depend on timing rather than on the program.

**Output belongs to its cell.** Every write is attributed to the cell that
produced it, including writes from a continuation that outlives its cell. Output
that belongs to no cell is discarded rather than assigned to whichever cell
happens to be running.

**A cell cannot report its own outcome.** Status, results, and errors reach the
host only through an authenticated channel a cell cannot write to.

**Bindings are incremental.** A cell is a sequence of bindings, not a
transaction. Names bound before a failure stay bound, and closures observe later
rebinding rather than a snapshot from their own cell.

**Cancellation costs one cell.** The namespace survives, and the cancelled
cell's continuation cannot write to it or keep streaming output.

**Durability is automatic and honest.** Successful cells schedule a snapshot;
nothing depends on remembering to save. Values that cannot be serialised are
reported by name.

**Teardown fails loudly.** Every call against a stopped engine rejects
immediately. Nothing hangs.

## Decisions

### The namespace is a proxy, and declarations become assignments

Cells run inside `with (proxy)`, so unqualified reads and writes go through the
namespace. But a top-level `let x = 1` inside that block creates a *local*
binding in the wrapper function, not a namespace entry — which produces two bad
behaviours: a closure captures the local and never sees later updates, and
nothing reaches the namespace if the cell throws before the end.

So the transform rewrites declarations into assignments: `let x = 1` becomes
`x = 1`, `function f() {}` becomes `f = function f() {}`. Each binding lands as
it executes. Functions keep their own name for recursion.

The cost is REPL semantics rather than module semantics: no temporal dead zone,
no const-ness across cells, and a redeclaration overwrites. That is the right
trade for a notebook, where incremental redefinition is the normal way to work.

### Cancellation is cooperative, and says so when it cannot be

Cancelling sends the guest an abort, stops forwarding the cell's output, and
resolves the caller after a short grace period. The cell's continuation may
still be scheduled — that cannot be undone — so instead its writes are refused:
the cell context carries an aborted flag the namespace proxy checks.

A cell spinning in synchronous code never yields, so nothing can interrupt it.
The engine does not pretend otherwise: the next call raises `EngineBusyError`,
and recovery is to kill the engine and start a fresh one, whose `restoreState`
brings the last snapshot back. Losing the process should not mean losing work.

### The protocol is separated and authenticated

Two properties, both load-bearing:

*Separation.* Protocol traffic uses a dedicated pipe (fd 3). The guest's stdout
and stderr carry only user output, so a cell printing JSON is just a cell
printing JSON.

*Authentication.* Every frame carries a nonce the host mints at spawn and the
guest erases from its environment before running any cell. Code inside a cell
cannot recover it.

Without both, a cell could announce its own completion — claiming success while
failing, or attributing output to another cell. An agent that cannot trust its
own results has nothing left to reason with.

### Snapshots are per-variable and best-effort

The namespace is serialised entry by entry, so one unserialisable value costs
only itself. Functions, live handles, and open resources do not survive; the
restore report names them. Engine-owned bindings are re-installed after a
restore, so a stale saved value cannot shadow a live handle.

### Subagents return handles, not answers

`rlm.run` resolves at admission. A parent that blocked until its child finished
could not supervise it, and a handle is useful immediately while an answer is
not. Children write their final output to a file; the registry reports running,
completed, or errored, so the parent decides when to read.

### pi's tools are mounted behind the bridge, not registered with pi

The session runs with pi's builtin tools disabled; the model's only tool is
`execute`. But pi exports its tool implementations as plain ToolDefinitions,
so the host mounts them itself (`pi-tools.ts`): cells call
`await tools.read({ path })`, the request crosses the guest bridge, and the
definition executes host-side with the calling cell's abort signal. Arguments
are validated against each tool's own TypeBox schema before execution — a
failure names the problem and shows the expected signature, and an unknown
tool name suggests the nearest real one. The prompt's signature list is
generated from the same schemas, so documentation cannot drift from
validation.

The bridge instantiates the tool definitions itself rather than reusing the
ones pi registered for the session: pi's extension API exposes active tool
*names* (`getActiveTools`), not definitions, so there is no clean handle to
the registered objects — and in the activated configuration the builtins are
deactivated anyway. Instantiating from the same factories pi uses keeps the
behaviour identical at the cost of a second (idle) set of definition objects.

Two consequences of the bridge being JSON: tool details cross as data, and
image blocks cannot cross as pixels the model would see. Images are therefore
held host-side and forwarded into the cell's tool-result content; the guest
value reports `images: n`. Costs: a bridged tool runs host-side, so its
filesystem view is the host's (same machine, same cwd — a difference only if
the guest ever runs elsewhere), and its output is data returned to the cell
rather than transcript output.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cell throws | `status: "error"` with name, message, and stack; namespace intact |
| Cell cancelled | `status: "aborted"`; continuation cannot write or stream |
| Synchronous infinite loop | Abort settles; next call raises `EngineBusyError`; recover by restarting and restoring |
| Stray async throw | Reported as cell stderr; the evaluator stays alive |
| Guest process dies | Pending calls settle, engine reports itself down, later calls reject |
| Host exits | Guest is killed; if the host dies abruptly, the guest self-exits on stdin EOF |
| Output flood | Capped per channel with the truncation announced |

## Testing

`test/engine.contract.test.ts` is the specification: behavioural tests against a
real engine and a real guest, each stating a guarantee and its rationale.

`test/units.test.ts` covers what behaviour alone cannot reach — the transform
(which runs in the guest process), protocol framing, prompt assembly, and cell
layout, including the width invariant that keeps a row's metadata legible at any
terminal size.

`test/subagents.test.ts` covers delegation with an injected spawn command.

`bun run check` is the gate: typecheck, lint, and the full suite.
