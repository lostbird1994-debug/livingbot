# LivingBot 2.0 Development Handoff

## Superseding user correction — 2026-11-20

The replacement workbench-web frontend is rejected. Use the existing
1.0-derived incremental frontend and adapt it to the retained native backend.
Avatar selection, Bot sections, pinning and settings are existing product
behavior to restore, not optional new features.

Creative/Expert pages and their dedicated engines, routes, tools and skills
have been removed at the user's request. Do not follow older creative/expert
assignments or recreate those modules. General native tools, file delivery,
group collaboration and GitHub ability sharing remain in scope.

Earlier counts, release-candidate claims and creative/expert completion below
are historical. Inheritance, selected-frontend panorama and platform acceptance
are reopened in feature_list.json. Do not rebuild or reinstall the rejected UI
as a final deliverable. No new product module is authorized by this correction.

## Earlier handoff (history)

Updated: 2026-11-20
Status: 22/28 acceptance gates verified; the eight-stage objective is incomplete.
The latest memory integration and delegation diagnosis have been delivered.
Return the complete correction batch for one consolidated Codex acceptance;
do not request review after each individual fix.

## Product Goal

Build LivingBot 2.0 as an independent local-first product with OpenClaw as its
actual agent kernel, not as a bridge to the previous runtime. Preserve the
complete reviewed WorkBuddy experience baseline as a product requirement:
recreate its useful behavior and workflows as closely as possible, prioritizing
readable reference implementations and specifications over new alternatives,
without silently reducing scope for convenience. Vendor reference material
stays in ignored local storage; this does not authorize publishing vendor assets.

The user's latest instruction supersedes the earlier blanket no-source-copy
strategy. Any feature/module requiring 100% independent development from scratch
needs explicit user approval before implementation, across the entire product.
Research, source preservation and comparison are authorized; a reference-inspired
original implementation must not be misreported as a source port. Existing
working custom code is assessed before replacement, not automatically discarded.

The 1.0 checkout, running service, databases, Bot workspaces, credentials and
default app selection are out of scope. Never migrate or replace real Bot data
unless the user explicitly initiates that workflow after preview and verified
backup.

## User Decisions

- The eight selected Bots are `crying`, `captain`, `david`, `echo`, `scout`,
  `一九九四`, `四月`, and `小鲸`.
- Keep LivingBot's own internal group conversations. Do not design around
  Feishu groups. Bots must be able to use permitted group context in private
  conversations and understand private reporting destinations without
  exposing unrelated private conversations.
- Remove cloud-computer and virtual-machine product scope. The direction is
  local computers. Do not add the unwanted Cursor or xAI application catalogs.
- Replace the confusing connection-app market with one ordinary-language
  capability center for skills, tools, external services, connectors and
  account authorization. Users should not need to know those implementation
  terms.
- Keep the idea of a clickable Bot panorama, but glassmorphism and the final
  visual direction remain undecided. Do not treat a style preference as
  approved; present a coherent, distinctive working design for review.
- Standardize Bot workspace folders and file creation rules without moving or
  rewriting existing user files.
- Keep GitHub-backed sharing/install for Bots and abilities in scope, with
  reviewed immutable packages, permission previews, versioned updates and
  privacy-preserving exports.
- Bots should eventually delegate work to Codex and WorkBuddy. Their setup UI
  is explicitly deferred; do not block core development on it.

## Accepted Kernel Boundary

OpenClaw 2026.11.5 is the pinned version used for isolated native acceptance.
It is the sole execution kernel. Workbench is LivingBot's
product layer, not part of OpenClaw: it owns the user-facing workbench,
conversation/product records, capability organization and workflow
orchestration while using official OpenClaw interfaces.

Recovery acceptance is deliberately split by failure type:

- Normal execution, graceful Gateway restart and full Workbench+Gateway restart
  preserve four accepted inputs in FIFO order, stable submission identities,
  and one final result per task. OpenClaw's graceful restart marker resumes
  interrupted root work and admitted followups after workspace preparation is
  ready.
- SIGKILL does not promise automatic replay. LivingBot identifies exact
  unresolved native receipts, marks affected tasks interrupted, and lets the
  user explicitly continue each original task. Continuation retains task and
  delivery ownership and is idempotent after a lost acknowledgment. Do not
  blindly replay hard-crash tasks: external effects may already have happened.
- No periodic runtime-state poller was introduced. Reconciliation is
  event/reconnect/startup triggered and uses bounded exact history/receipt
  reads.

The prior queue check incorrectly combined graceful restart and SIGKILL while
requiring automatic crash replay. It has been separated into the native queue
fixture and explicit crash-continuation fixture. Both policies now have passing
evidence and are not interchangeable.

## Eight Stages

1. **Isolation and experience inventory**: preserve 1.0 and freeze the full
   WorkBuddy plus existing-product workflow matrix. Both foundation gates are accepted.
2. **Kernel reliability**: OpenClaw events, durable sends, FIFO/restart
   recovery, exact interactions and stop ownership. The `s2-events`,
   `s2-stop`, `s2-recovery`, and `s2-interaction` tracker gates are accepted.
3. **Single-Bot complete work experience**: conversation, streaming, files,
   rich documents, long work, notifications and failure recovery. Prioritize
   this stage next; do not spend further time expanding multi-file batching
   without a product-critical acceptance need.
4. **Memory and migration**: native Chinese memory and scoped recall/forgetting;
   preview and verified-backup migration for the eight selected Bots. Real
   import requires a separate explicit user action.
5. **Groups and collaboration**: internal LivingBot groups, audience-scoped
   context and private report workflows.
6. **Abilities, delegation, market and WorkBuddy parity**: unified ability
   center; Codex/WorkBuddy delegated children; GitHub package market; complete
   document, creative, research and expertise workflows.
7. **Visual system and platforms**: distinct reviewed visual language, Bot
   panorama, desktop/web/mobile shared contracts and native-platform behavior.
8. **Acceptance and independent release**: complete requirement-level
   acceptance, installable independent release and verified rollback. User
   controls whether 2.0 becomes the default; do not switch it automatically.

The stage list is the delivery sequence. `feature_list.json` is the finer
grained 28-gate evidence ledger; do not treat its current count as completed
stages. It currently records 22/28 gates verified; the ledger remains the
authoritative source when this handoff and an older delivery differ.

## Next Work

Finish the already consolidated release corrections before starting more
investigations. The latest packaged local-memory runtime contains library
symlinks pointing outside the application, so startup on the build machine
does not yet prove an independent install. Preserve valid internal library
targets and verify the final bundle's strict signature and link closure.
For accepted inputs whose native run completes empty, report the lack of an
independent result truthfully. Retained evidence shows that some inputs reached
a background notice's model turn; do not claim they never executed or
automatically resend them. Keep explicit steering behavior unchanged.

The host keeps the single complete correction list and exact delivery records
in ignored local coordination storage. Integrate all listed fixes, run only
affected checks and produce one complete candidate. Codex then reviews the
whole batch. Do not repeat unchanged paid executor, workbook, migration or
creative suites.

Continue from the current parallel coordination and completed delivery records;
do not restart accepted stage-3 work from the historical stage sequence.
Read `AGENTS.md`, `progress.txt`,
`feature_list.json`, `docs/v2/experience-matrix.md`,
`docs/v2/release-priorities.md`, `docs/v2/native-validation.md`, and the
relevant implementation before changing code.

For each stage, work from the observable workflows in the experience matrix.
Keep acceptance evidence and `passes` updates tied to the exact gate. Run the
focused tests, typechecks, real official-kernel fixture and browser acceptance
that match the changed workflow. Keep unresolved semantic claims explicitly
unverified. Do not infer completion from a build, screenshot or lower-layer
test alone.

Preserve current uncommitted work. Do not clean up fixtures or artifacts by
permanently deleting them. Do not run routine Electron Playwright on the
maintainer's macOS desktop. Do not publish, commit, change the 1.0 checkout,
activate real migrations, or switch release defaults unless separately
authorized.

## Historical Foundation Evidence

These are the earlier foundation results, not a current whole-product test
count. Later complete batch receipts and the tracker supersede them:

- Official OpenClaw `kernel.integration.ts`: 20 scenarios pass.
- `steering.integration.ts`: 3 scenarios pass.
- `queue.integration.ts`: 3 scenarios pass (normal, Gateway restart, full
  product restart).
- `crash-continuation.integration.ts`: 4 scenarios pass (exact crash receipts,
  product reopen/generation, lost continuation acknowledgment, four explicit
  original-task continuations).
- `packages/workbench/src/interactions.test.ts`: 6 tests pass.
- `pnpm --filter @livingbot/workbench test`: 148 tests pass.
- `pnpm --filter @livingbot/workbench check`: passes.
- At that foundation checkpoint, `feature_list.json` had 10/28 gates verified.
  The current count is 22/28; neither count means all eight stages are complete.

## Current Open Gates

- `s4-memory`: native semantic file recall, same-agent private context injection,
  other-agent exclusion and calibrated inline LLM review have evidence.
  The optional external judge script has not run. Standalone packaged memory
  still needs the runtime-link correction above; transcript paraphrase coverage
  and real-model answer quality remain limited.
- `s4-migration`: previews and verified backups exist. Importing and validating
  the eight real Bots still requires explicit user initiation.
- `s6-delegation`: real Codex execution, cancellation and fresh file delivery
  have evidence. WorkBuddy's CLI requires interactive login before inference.
  Its configuration UI remains deferred.
- `s6-creative`: implemented references, series linkage, presentations and local
  preview must not be confused with verified real image generation, semantic
  consistency or public publication.
- `s7-design`: rendered and keyboard checks have evidence; user review of the
  visual direction is outstanding.
- `s8-release`: an independent candidate exists, but the current packaging
  correction, full selected-Bot acceptance and remaining gates prevent a
  complete-release claim. The user controls import and default switching.

Native fixtures use the official OpenClaw runtime and a synthetic local model.
They verify transport, ownership and observable effects, not natural-language
quality or WorkBuddy parity. Full root test suite has not passed; an earlier
run had unrelated Vitest setup/import failures. Desktop E2E is intentionally
left to CI.

## Handoff Request

Continue implementing LivingBot 2.0 from stage 3 onward. Keep the full agreed
scope. Deliver work in stage-sized increments with a concise implementation
summary, changed paths, exact tests/evidence, open gaps and the proposed next
stage. Do not mark a gate complete without matching acceptance evidence.
