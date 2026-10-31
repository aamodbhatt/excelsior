# excelsior: design

## Goals

1. A spreadsheet calculation engine that is **correct** (Excel-compatible semantics where they are documented,
   explicit and tested semantics where they are not) and **fast** enough that iterative calculation can run
   hundreds of gradient-descent steps per second.
2. A compiler from small neural networks to workbooks whose formulas *are* the model, verified against
   NumPy and PyTorch to float64 precision.
3. A collaborative web app around it: canvas grid, formula editing, live multi-user editing, version history.

## Non-goals

- Full Excel parity (VBA, pivot tables, 400+ functions, every number format).
- Offline-first editing. Clients queue and resend, but the server is the source of truth.
- XLSX round-tripping in this version (see the roadmap in the README).

## Engine

### Data model

- **Values** are `number | string | boolean | CellError | null`. Arrays are `ArrayValue` (boxed),
  `NumMatrix` (`Float64Array`, the fast path) or `RangeRef`. A `RangeRef` is a lazy view of a sheet region
  that is never copied unless a function needs to.
- **Storage** is columnar and block-sparse. Each column holds blocks of 1,024 rows with a `Uint8Array` type tag, a
  `Uint8Array` kind (constant / formula / spilled value) and a `Float64Array` of numbers. Text, booleans and errors
  live in a side array. Range scans and `readNumbers` are typed-array loops that skip empty blocks.
- **Formulas** are parsed by a Pratt parser into an AST, then compiled into a closure tree. Relative
  references are compiled as offsets from the formula's own cell. The compiled closure is keyed by the
  AST's R1C1 shape, so fill-down copies share one closure.

### Dependency graph

- Each formula's static precedents are resolved to `(sheet, rect)` pairs.
- **Single cells** go into a per-sheet `Map<cellKey, Set<formula>>`.
- **Ranges** are deduplicated by rect and stored once. Narrow ranges (≤16 columns) are bucketed per
  column; wider ones go into a short scan list. A point query visits the cell map, one column bucket and
  the wide list. A rect query (used when a spill changes extent) intersects ranges.
- **Names** contribute their own precedents to every formula that uses them. Redefining a name re-registers
  those formulas.
- A blocked spill **watches** its intended area (minus the anchor cell), so clearing the blocker re-runs it.

### Scheduling

`recalc()` gathers seeds: edited formulas, dependents of edited cells, dependents of cleared spill areas,
and volatile formulas (unless the workbook is seeded). Then it:

1. Walks dependents breadth-first to collect the affected set and builds a CSR adjacency. A formula's
   successors include readers of any cell in its current spill range.
2. Runs an **iterative Tarjan SCC** pass (explicit stacks, so a 100k-long chain uses no recursion). Tarjan
   emits SCCs in reverse topological order.
3. Orders members of each SCC **row-major** (sheet index, row, column) and marks **integrators**: members
   that read another member at the same or a later position, including themselves.
4. Evaluates the plan:
   - no cycles: once, in order;
   - cycles with iteration disabled: cycle members get `#CIRC!`, everything else evaluates;
   - cycles with iteration enabled: cells upstream of every cycle run once. Then the **core** (cyclic cells
     plus anything that feeds an integrator) runs `maxIterations` times, Gauss–Seidel, stopping early when the
     largest change in a cyclic cell is below `maxChange` (unless a fixed iteration count was requested).
     Finally the rest of the downstream region runs once.
5. If any spill changed extent, dependents of the old and new areas form a follow-up round (bounded at 8).

### Invariants

- After `recalc()` returns, every formula's value equals what a full recomputation from scratch would
  produce. This is property-tested on random DAGs with random edits. For cyclic regions under iteration it
  holds for the defined iteration semantics.
- A spill never overwrites an input cell or another anchor's spill. Blocked anchors show `#SPILL!` and
  recover when the blocker is removed.
- **Integrator values are the complete iteration state.** Within one iteration a non-integrator member only
  reads values computed earlier in the same iteration, so it is a pure function of the current integrators
  (and of upstream inputs). `getIterationState()` returns just the integrators. `setIterationState()` writes
  them back and *settles*: it evaluates every non-integrator once without advancing the iteration. A restored
  workbook therefore matches the original bit for bit, which is tested.

### Failure modes

| Situation | Behavior |
| --- | --- |
| Syntax error in a formula | The cell shows `#NAME?` with the parser message as detail; the document keeps the text |
| Reference to a missing sheet | `#REF!` until a sheet with that name appears (sheet changes rebind all formulas) |
| Circular reference, iteration off | `#CIRC!` on every member of the cycle and on its dependents |
| Runaway LAMBDA recursion | Caught at the evaluation boundary and reported as `#NUM!` in that cell |
| Spill extent oscillating | Follow-up rounds stop after 8; the last computed state is kept |
| Non-finite arithmetic | `#NUM!` (or `#DIV/0!` for division by zero); the typed fast path falls back to the checked path |

## The nn2sheet compiler

The compiler emits a `WorkbookDoc` (the same JSON the app stores) with cells, styles, defined names,
conditional formats, charts, watches and actions.

**MLP.** The parameters (`Train!B12:E27`, one row per hidden neuron, plus the output bias) are integrators of
the form `=IF(Reset, init, self - LearningRate * gradient)`. The network lives on `Net`: one spilling block per
equation, all anchored on row 5 and ordered left to right in pipeline order. Because the parameters are on
the first sheet, the row-major rule evaluates them first in every iteration, reading the gradients from the
previous iteration. Then the forward and backward pass recompute from the updated parameters. That is
exactly `θ ← θ − η∇L(θ)`. The parity test checks all 65 parameters and the loss at each of 200 steps against
NumPy; the largest difference is 2.2e-15.

The initial state is computed by the engine itself: one iteration with `Reset = TRUE`, then the document
stores `Reset = FALSE` together with that iteration state. Opening a template therefore shows step 0 without
advancing training.

**Transformer.** Weights are constants on a `Weights` sheet, exposed through defined names (`L0_Wq_h1`, ...).
Linear layers are stored transposed so every projection is `MMULT(x, W)`. LayerNorm, GELU (tanh form), causal
attention and softmax are named `LAMBDA`s. Causal attention is computed as `exp(s)·mask / rowsum`, which is
algebraically equal to masking with −∞ (tested in Python). Each attention map is a T×T spill with a color scale.

## Collaboration

**Choice: server-sequenced operations, not a CRDT.** Every op is an overwrite: set these cells' inputs or
styles, rename a sheet, replace the iteration state. With one sequencer per workbook:

- **Convergence** is trivial. Clients apply commits in version order, and local pending commits are replayed on
  top of the confirmed document until acknowledged (`confirmed + pending = view`).
- **Version history** comes for free: version *n* is the snapshot ≤ *n* plus a replay of the op log. Snapshots are
  gzip-compressed every 50 versions and when the last client leaves.
- **Authorization** is enforced per op on the server. Viewers' commits are rejected with a reason.
- **Idempotency**: each browser tab picks a stable client key, and `(client, clientOpId)` is unique in the op log.
  A commit resent after a reconnect is acknowledged, not applied twice.

A CRDT such as Yjs would add tombstones and per-character metadata to solve concurrent text merging inside a cell,
which spreadsheets don't need. Its operations also can't be validated against roles without decoding them.
The cost of our approach is that offline work is limited to a resend queue.

**Training and collaboration.** The client that presses *Train* runs iterations in its worker. About once a
second, and on pause, it commits the iteration state (a few hundred numbers for the MLP). Other clients
apply it with `setIterationState`, so they follow the training and do not diverge. Each such commit is
also a version, which is what the history timeline replays.

## Web app

- **Grid.** A canvas sits under a native scroll container whose spacer has the virtual size. Row and column
  offsets come from an `Axis` with sparse size overrides: O(log k) offset lookup and binary-search hit testing.
  Above 15M px of content the scrollbar maps proportionally, to stay under browser element-size limits.
- **Data flow.** The worker owns values. The UI subscribes to the visible block (snapped to 50-row and
  10-column tiles), to conditional-format ranges, chart series and watched cells. After each recalculation the
  worker pushes only subscriptions that intersect a changed region.
- **Editing.** One formula editor component serves both the formula bar and the in-cell editor. It overlays a
  transparent input on a syntax-highlighted mirror, with autocomplete and signature help from the engine's
  function metadata.

## Security

- Passwords: scrypt (N=16384, r=8, p=1, 64-byte key, per-user salt), parameters stored with the hash, constant-time
  compare. The login path hashes even for unknown emails, so timing doesn't reveal accounts. Logins are rate limited.
- Sessions: 32 random bytes in an `HttpOnly; SameSite=Lax` cookie. Only the SHA-256 of the token is stored.
- CSRF: state-changing requests must come from an allowed `Origin` (or be same-site per `Sec-Fetch-Site`) and
  carry `application/json`. WebSocket upgrades check `Origin` too (cross-site WebSocket hijacking).
- Input validation: request bodies and socket messages go through zod schemas, and every op through `validateOp`
  against the current document.

## Alternatives considered

| Decision | Alternative | Why not |
| --- | --- | --- |
| Closure compilation | AST interpreter | Closures avoid a dispatch switch per node; interning keeps the memory cost per shape |
| Row-major cycle order | Jacobi (all reads from the previous iteration) | Jacobi pipelines a network: layer *k* would see weights from *k* iterations ago, so it is not gradient descent |
| Tarjan on each recalc | Maintaining a global topological order | Edits are local; recomputing the affected subgraph is simpler and handles cycles and spills uniformly |
| Values in a worker, viewport subscriptions | Main-thread engine | Training would block input and rendering |
| SQLite op log + snapshots | Storing only the latest document | History is a product feature, and replay makes it cheap |
