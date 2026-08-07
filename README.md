# pi-rlm

A [pi](https://pi.dev) extension that replaces the usual toolbox with a single
tool: **`execute`**, which runs TypeScript in a persistent Bun evaluator.

Everything an agent would normally reach for a separate tool to do — reading
files, running shell commands, editing, searching, delegating to subagents — is
expressed as code inside that one tool.

```
 ✓ rlm · shell · const files = (await Bun.$`ls -1`.text()).split("\n") · ↑ 2 ↓ 7 lines · 41ms
 ✓ rlm · const tests = files.filter((f) => f.includes("test")) · ↑ 1 ↓ 1 lines · 3ms
```

The second cell reuses the first cell's variable. Nothing was re-read, and
nothing was re-parsed from text — because the evaluator is still there.

## Why one tool

A fixed set of tools is a fixed vocabulary. Every new capability means a new
tool, a new schema, and a model that has to be taught when to reach for it.

Here the vocabulary is a programming language. Capabilities arrive as functions
in the evaluator's namespace rather than as entries in a tool list, so the
interface the model sees never changes while what it can do keeps growing. It
also changes how an agent works: intermediate results live in variables instead
of being re-derived from earlier output, so a long task compounds rather than
repeating itself.

## What the agent gets

**A namespace that persists.** Variables, functions, classes, and imports stay
available across calls, across turns, and — on a best-effort basis — across
session resumes. Whatever cannot be serialised is named in the restore report
rather than silently dropped.

**Shell as values, not text.** `await Bun.$`git log --oneline`.quiet()` returns an
object with an exit code and captured output, ready to be assigned and filtered.
No parsing a transcript to recover what a command said.

**Subagents as function calls.** `await rlm.run("task")` spawns a real child
agent and returns a handle at admission. Children write their answers to files;
the parent polls the registry and reads them when it wants. Delegation happens
mid-computation instead of as a separate mode.

**Cancellation that costs one cell.** Interrupting a running cell leaves the
namespace intact, and the cancelled cell cannot keep writing to it afterwards.

## Install

```bash
pi install npm:@shift-labs/pi-rlm
```

**[Bun](https://bun.sh) is required.** pi itself runs on Node, but the evaluator
is a Bun process — without it on your PATH the engine will tell you so and stop.

```bash
curl -fsSL https://bun.sh/install | bash
```

## Launch

The extension is dormant until asked for. A plain `pi` session is untouched —
default prompt, default tools, no evaluator. Activation is one flag:

```bash
pi --rlm
```

That collapses the tool surface to `execute` and replaces the system prompt;
no other pi flags are needed. To verify the two worlds:

```bash
pi -p "what tools do you have?"          # stock pi: read, bash, edit, ...
pi -p --rlm "what tools do you have?"    # one tool: execute
```

To run from a clone (development), load the extension explicitly — the flag
works the same, or set `PI_RLM_FORCE=1` where flag plumbing is awkward:

```bash
git clone https://github.com/shift-labs-ai/pi-rlm && cd pi-rlm
bun install
pi --rlm -e ./src/extension/index.ts
```

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_RLM_SUBAGENT_MODEL` | `anthropic/haiku` | Model children are spawned with |
| `PI_RLM_MAX_DEPTH` | `2` | How deep recursive delegation may go |
| `PI_RLM_DEPTH` | `0` | Depth of the current agent; set on children automatically |
| `PI_RLM_NPM_CACHE_DIR` | `~/.cache/pi-rlm-npm` | Cache for lazy `npm:` imports |

Session state lives in `.pi-rlm/<session>/`: the namespace snapshot and each
subagent's session file and output.

### npm imports

Static top-level imports can use npm-style specifiers. Packages install lazily into
the cache and load through Bun:

```ts
import { z } from "npm:zod@4";
import express from "npm:express@5";
```

Pin versions when repeatability matters. This feature installs and executes npm
packages, so treat specifiers as code-execution input. Dynamic `import("npm:...")`
is not supported yet.

## How it works

The extension runs a Bun child process that owns the namespace. Cells are
transformed so their top-level declarations become namespace assignments, then
executed inside a `with` block over a proxy. Host and guest talk over a private
pipe with authenticated framing, which is what stops a cell from being able to
report its own outcome.

[ARCHITECTURE.md](ARCHITECTURE.md) covers the design and the reasoning behind it.

## Development

```bash
bun run check      # typecheck, lint, and the full suite — the gate
bun test           # tests only
bun run typecheck  # tsc --noEmit
bun run format     # biome
```

The test suite is the specification. `test/engine.contract.test.ts` states each
guarantee the evaluator makes and why it exists; read it before changing engine
behaviour, and never weaken a case to make a change pass.

## Layout

```
src/engine/      the evaluator
  index.ts       EngineManager — host side: lifecycle, queueing, output, snapshots
  guest.ts       the Bun process that owns the namespace and runs cells
  protocol.ts    typed, authenticated framing between the two
  transform.ts   cell source → executable body
src/extension/   the pi integration
  index.ts       tool registration, session wiring
  prompt.ts      the system prompt
  subagents.ts   spawning, registry, file-based results
  render-core.ts cell layout (pure)
  render.ts      binds pi's theme and width primitives to it
```
