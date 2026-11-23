# Native validation

The default offline tests validate structured contracts and observable effects:

```sh
node --test packages/kernel-runtime/src/*.test.ts packages/workbench/src/*.test.ts \
  apps/workbench/src/*.test.ts apps/workbench-web/src/*.test.ts
```

Tool payloads are arbitrary native output, so a tool step keeps only an explicit
projection: native identifiers, phase and bounded scalar outcomes. Nothing else
is persisted or sent to a client, which also keeps old receipts small. Reply
state is derived from the owning task, so an unfinished document never claims
that work is still running after an interrupt, stop or failure.

Native integration is explicit. It starts an isolated local Gateway, uses a
synthetic local model, and retains evidence beneath ignored
`local/test-fixtures/`. It never imports production Bot data. Supply an already
initialized official kernel; the launcher refuses an incomplete installation.

The core service integration additionally records actual official event kinds
and requires assistant, tool, lifecycle, final and provider-error events, with a
failed product task and committed reply for the controlled provider rejection.
Together with the source boundary and event-triggered reconciliation audit,
these establish the sole-kernel event gate; they do not establish every recovery,
interaction or semantic workflow as complete.

For portable batch migration of eight synthetic Bots:

```sh
node apps/workbench/src/migration-batch.integration.ts \
  --kernel-entry /path/to/openclaw/openclaw.mjs
```

This verifies authenticated preview without activation, eight explicit imports
with fresh verified backups, database persona and color, native memory search,
eligible workspace skills and one real native turn per imported Bot. Repeating
the preview and import creates no duplicates. A full application and Gateway
restart retains all eight imports and their searchable memories. These are
synthetic fixtures; this check does not activate the user's selected Bots or
establish parity for global skills and external account connections.

The batch also includes two distinct shared-memory audiences and a shared
method with supporting reference files. Each Bot can search its original
audience's shared memory and load the shared skill; the other audience's
reference is absent. Portable preparation can compose these verified
supplemental backups beneath explicit workspace directories. Conflicting files
refuse preparation rather than replacing either source. Skill inspection
retains support scripts and references without following links inside a skill
or executing its contents. A copied skill can still require external commands,
accounts or dependencies; file preservation alone does not establish readiness.

For native Chinese memory, private recall, audience exclusions and forgetting
preview:

```sh
node apps/workbench/src/memory.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

Eight structured scenarios pass with a synthetic model. The forgetting preview
resolves a real indexed session, reports its index chunks, preserves the memory
file and searchable transcript, retains its receipt across a kernel restart,
and distinguishes an unresolved conversation. These checks establish native
protocol and storage effects, not a real model's semantic recall quality.

The pinned native `memory forget --dry-run --json` requires exclusive offline
ownership, including for previews. The authenticated user must explicitly allow
the kernel pause. Product admission refuses unfinished turns and background
programs without inheriting UI pagination; native active or uncertain runs also
prevent the pause. New submissions are refused during maintenance. The owned
Gateway stops before the official command, restarts afterward even on preview
failure, and an explicit application shutdown takes precedence over restart.
There is no runtime-state polling. Native preview may initialize stores; it
does not request content forgetting.

The memory page exposes affected counts, unresolved sessions, mixed lineage,
untargetable entries, curated-write review candidates and native refusals.
Changing the selected Bot or conversations discards stale preview output.
Explicit recovery preparation rechecks the reviewed preview digest while
offline, copies the kernel state and selected workspace, syncs the copied
files and directories, and verifies every recorded hash plus directory/file
inventory. Empty directories are retained. Temporary CLI shims and regenerated
plugin method links are excluded explicitly in the manifest; other symbolic
links and unsupported file kinds refuse preparation. A changing source,
modified backup, unrecorded file or invalid path fails verification.
The recovery folder is private. The kernel snapshot includes shared plugin
state and other agents' native databases, so it is a whole-kernel recovery
resource, not a promise of selective per-Bot database rollback.

The user can save a recovery copy from the preview and find its receipt again
in the Bot's recovery inventory after restarting. The inventory is user-only.
Completed apply receipts also retain native outcomes and the original/Trash
paths so these remain available after navigation or restart. Nine native scenarios pass,
including verified agent database, shared plugin store and workspace copies.
The copy does not prove restoration works: restoration must independently
preserve newer data and obtain explicit user authorization for its actual scope.

Explicit apply requires the reviewed digest, user confirmation and pause
consent. It rechecks the native preview offline and creates a fresh verified
copy immediately before applying; an older recovery copy is not reused.
The command runs through the initialized official kernel and public
`agent-workspace-runtime` maintenance registration. Official native code owns
provenance, tombstones, databases, index/cache cleanup and the final report.
The local maintenance boundary moves rewritten or removed workspace originals
to macOS Trash, verifies the retained bytes, writes replacements exclusively,
and syncs the files, directories and operation journal. It never permanently
deletes empty corpus files. Apply is currently available only on macOS.

Before native execution, the operation durably binds the product review ID,
agent, exact session selection and reviewed digest. Matching retries read the
original disk outcome without running the command again. On application
restart, missing product receipts are recovered from those exact disk outcomes.
An unfinished or uncertain running operation prevents kernel startup; it is
never silently replayed. Failed maintenance retains the stopped kernel and
its verified recovery copy. These protections do not establish interrupted
operation restoration or undo: both remain required, and E35 stays Partial.

For recoverable native apply and receipt recovery:

```sh
node apps/workbench/src/memory-forget.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

Seven structured scenarios pass: verified offline backup, recoverable original
files in Trash, removal of matching workspace artifacts with unrelated memory
retained, startup acceptance of the completed disk outcome, exact retry without
another apply, Gateway restart, and full product restart repairing an
intentionally missing product receipt. A synthetic browser workflow additionally
checks the explicit confirmation, successful native apply and recovery inventory
at wide/light and narrow/dark sizes. This does not prove selective database
rollback, restoration after a partially executed command, or real-model semantic
forgetting quality.

For configured service permissions, discovery, edits, removal and restart:

```sh
node apps/workbench/src/connections.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

For native external delegation, result delivery, cancellation and restart:

```sh
node apps/workbench/src/delegations.integration.ts \
  --kernel-entry /path/to/openclaw/openclaw.mjs \
  --acp-plugin /path/to/@openclaw/acpx
```

For ordinary commands, independent background services, scoped cancellation,
native escalation and command timeouts:

```sh
node apps/workbench/src/processes.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

The process check starts real synthetic local programs. It verifies their
operating-system exits as well as the product's confirmed states, and checks
that another task's program in the same conversation remains alive. Its PID
files and evidence are retained.

For active-turn steering, idle sends and a lost receipt across a full restart:

```sh
node apps/workbench/src/steering.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

This check holds a real native model turn open, submits an additional
instruction through official steering, then verifies that the next model
request receives it once. It deliberately loses the steering acknowledgment
and restarts the product and Gateway. Recovery must retain the original task,
recover the same input receipt and start no extra model turn. An empty
steering terminal confirms input delivery only; the original task's final
still owns completion.

For ordered followups and restart fault injection:

```sh
node apps/workbench/src/queue.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

This deliberately strict check submits four inputs per scenario, loses one
queued acknowledgment and verifies FIFO model requests, distinct task ownership,
one visible input and one delivered final per task through normal execution,
graceful Gateway restart and full product restart. These are the native durable
queue guarantees. SIGKILL recovery is tested separately below: the Gateway
relaunches, marks unresolved accepted work interrupted, and the user explicitly
continues each original task. The native protocol deliberately does not
automatically replay crash-left inputs because tool effects may already have
occurred.

For explicit user continuation after a hard crash:

```sh
node apps/workbench/src/crash-continuation.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

This separate check kills the owned Gateway after four admitted inputs reach
native queue custody. It reconciles exact input receipts, including inert
pending rows omitted from display history. The user then explicitly authorizes
each continuation through a fresh submission attached to its original product
task. The native physical session and transcript leaf fence that new send.
One continuation acknowledgment is deliberately lost; a full product restart
and an exact retry must retain the same receipt without another model call.
Every original task must receive one delivered final. Runtime generations
persist across product launches so later exits cannot reassign old crash
receipts. This passes with the pinned kernel and a synthetic model. It verifies
safe, actionable hard-crash recovery; automatic execution after SIGKILL is not
an OpenClaw guarantee and is intentionally not claimed.

For one ordered conversation document across a hard crash and product reopen:

```sh
node apps/workbench/src/conversation.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

Four scenarios use the real kernel and a synthetic model. A held turn in one
conversation must not block a second Bot in its own conversation, which commits
its own final reply, delivers an exact file and receives exactly one result
notice bound to that reply. A SIGKILL leaves one unfinished document with no
invented final, no credential in its retained tool projection and no notice; a
full product restart returns the identical ordered blocks with the task still
interrupted; an explicit continuation then delivers exactly one final without
rewriting the interrupted document. This establishes ordered persistence and
recovery ownership, not natural-language quality. Text/reasoning/tool
interleaving with the current build is exercised separately by the retained
real-kernel browser fixture that streams two reasoning stages around a tool.

For native scheduled work, missed-slot catch-up, permission enforcement and
active cancellation:

```sh
node apps/workbench/src/routines.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

The check loses a native creation acknowledgment, stops the entire product
past the scheduled time, and verifies that native startup catches up one
declaration. Its result and receipt must survive another complete product
restart without another model call. Future work is paused without deleting
history. A synthetic model actually attempts a disabled service call, which
must never reach that service. Disabling a running schedule must close its
model transport and retain a nonsuccess receipt.

Schedules execute in their existing destination session, preserving its
current native service restrictions. They use native `delivery.mode: "none"`:
the persistent execution path commits its result to its own conversation
without requesting an external announcement. Receipts retain the native
`not-requested` delivery status; a confirmed conversation result is checked
separately. Do not relabel this as externally confirmed delivery. Detached
operator-created jobs did not preserve session service denials in validation,
and persistent-session announce delivery failed without an external channel.
Neither path is accepted as a substitute.

Scheduled execution uses the official model-resolution and prompt-build
hooks to bind the host's exact job, agent, session and model-run identities.
The authenticated backend verifies native schedule ownership and activity
before creating a product task. The check exercises actual conversation
recall, file creation and immutable file delivery under that task. Hook
configuration permits conversation access for this application-owned plugin;
the binding callback sends only execution metadata and never changes prompts.
No input-provenance hint or human-authored cron-looking text grants authority.

The check also reopens the product after file delivery, then runs two native
recurrences with an ordinary user turn between them. Each occurrence must
retain its own task and the pause must preserve completed history. These
scenarios have passed together. Editing uses revision-bound native updates;
a deliberately lost edit acknowledgment is retried without another mutation,
and a full restart preserves the native schedule ID, paused state and both
previous receipts.

The current check additionally requires a durable result notification linked
to the actual final reply. Each recurrence has its own notice; the notice ID
and explicit read receipt must survive full product restarts. Notifications
and final messages are committed in the same product transaction and replay
cannot create a second notice. Lifecycle end, interrupted restart, user stop
and empty steering acknowledgments do not announce a completed result.
The pinned kernel emits an empty model terminal for scheduled conversation
work, then commits a separate automation-result transcript record. Its cron
job and occurrence provenance bind that content to the original host-bound
model run. The projection preserves its tool/file blocks and emits the notice
only when both the native terminal and committed result are present, in
either order. No latest-task or arrival-time heuristic associates replies.
All thirteen scenarios have passed together. Browser acceptance additionally
receives a scheduled result while outside its conversation, focuses the exact
reply through its notification and retains the read state after reload.
Operating-system notifications require separate acceptance.

For scheduled group assignments, separate private reports and partial failure:

```sh
node apps/workbench/src/scheduled-groups.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

This check uses a real scheduled coordinator and two distinct child Bots.
One child writes and delivers a real synthetic file; the other encounters a
synthetic provider rejection. Each outcome must retain its own private report
and notification. A full restart must preserve all three tasks, the file and
the original schedule receipt without reexecution. All three scenarios pass.
The private file card references the same immutable artifact as its originating
task; a separate private artifact copy is neither required nor created. Both
the private card and the exact file bytes survive the restart.

Browser acceptance reopens these native results without new model requests.
Each group outcome links to its exact private report, including provider
failure; the private source link returns to the group. The successful report
previews and downloads the actual delivered file, whose bytes match the native
artifact. Wide/light and 390px/dark views were reviewed without horizontal
overflow. This establishes navigation and delivery effects with a synthetic
provider, not real-model understanding of a natural-language assignment.

The event projector also accepts a matching tool-result receipt after a visible
terminal. It updates the existing tool block in the final source and private
report without changing task/run outcomes, final text or notifications.
Offline tests cover completed, failed and cancelled runs and duplicate receipts;
the native scheduled-group scenarios still pass after this change. Some native
group-assignment tool starts have no terminal event: their process display
remains explicitly unconfirmed rather than inventing completion.

For reviewed GitHub package installation, version updates and method access:

```sh
node apps/workbench/src/marketplace.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

Ten scenarios use synthetic package bytes with the real native Gateway,
workspace files and capability configuration. They create one independent Bot,
execute a task with its identity and installed method inventory, and retain the
same result after a full restart. Revocation disables the package's native
methods while retaining its Bot, identity, private memory and conversation.
Re-enabling after restart retains the original installation and agent.

A reviewed update installs methods under immutable version-specific names,
enables the new inventory and disables the superseded methods while retaining
their files. Public identity replacement is an explicit choice and requires a
verified retained backup; locally edited identity is retained unless its
conflict is resolved. The same Bot, private memory and conversation survive the
update. A subsequent complete restart and exact retry must not repeat work.
New method discovery uses the official `skills.status` refresh operation,
followed by native access confirmation; there is no timing delay or status loop.
The check also selects an installed method for a methods-only share, confirms
that private memory and Bot identity are absent, and installs the exported
package into another existing native agent. No new Bot may be created for that
ability installation. A final complete restart retains the exact reviewed
share and the second agent's installed method. The scenarios establish native
contracts, not research quality or complete marketplace acceptance. The real
public GitHub read path is verified separately.

The bounded
test wait follows native rescheduling events without shortening its deadline
when a completed job loses its next slot. Production has no dispatch or
state-polling timer.

The delegation check requires a separately installed matching official acpx
plugin with its dependencies available. It installs no packages, changes no
production configuration and authenticates no external executor. The fixture
implements ACP only to verify dispatch and cancellation through the actual
kernel and plugin. Passing is not evidence that Codex or WorkBuddy can complete
a real task, authenticate, or deliver files. Those remain separate acceptance
requirements.

Integration fixtures are retained for inspection. Cleanup must follow the
repository's Trash policy; these commands perform no explicit file cleanup.

Reasoning acceptance must use a model declaration that supports reasoning.
The native runtime can omit reasoning events when that capability is absent,
even if a synthetic compatible endpoint sends reasoning fields. The product
projects only actual native thinking events. Persistence-only receipts carry
item identity without text; they cannot create an empty block or move an
existing reasoning item past later commentary. A repeated text-bearing item
updates its original position. Browser acceptance covers two long stages,
active reload, complete product/kernel restart, manual expansion, the 200px
scroll limit and a final answer outside the collapsed execution process.
