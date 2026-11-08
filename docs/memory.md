# Memory

Bots remember what matters between conversations, and you can read, download or delete anything they
keep.

## What a bot remembers

Each bot writes notes as it works: your preferences, facts about the job, what it tried. Its notes are
indexed in a file called `MEMORY.md`.

You can also just tell it: "remember that invoices go to the finance folder".

To see what a bot remembers, click its name at the top of the chat and open **Memory**. Each note can
be downloaded or deleted.

## Shared memory

Some things every bot should know, such as your name, your company, or how you like reports
written. Those go in **Shared memory**, available to every bot in the [space](./spaces.md).
Shared `MEMORY.md`, `USER.md` and `profile.md` load automatically within the memory budget.
Other shared documents are listed for on-demand reads rather than loaded in every conversation.

Find it in **Settings → Memory**.

## Search and history

Summaries load within the selected model's context budget. Other documents are listed and read
on demand. Keyword search supports Chinese substrings, single characters and English fragments.
Encrypted notes use a separate keyed search index; matching candidates are decrypted and checked
before returning excerpts. Message-history indexing is unchanged.
Matching is a normalized literal substring, including spaces; several words are not combined
with AND. Review artifacts under `memory/reviews/` are excluded from agent context, browsing,
reads and ordinary search, while remaining available in human memory management.

When the model window is unknown, memory uses an allowance of 1,024 estimated tokens. Known
windows use one tenth of that window. Truncated summaries preserve their beginning and recent
tail with the missing character range marked. Token counts are heuristic, not provider usage.

Open a document's **Versions** to preview or restore a previous version. Restoring creates a new
version, and refuses to overwrite changes made since you opened the document.

## Daily memory review

Operators can enable a **Daily memory review** routine, at 18:00 in the account's timezone
(UTC if unset). Pause it in the bot's Routines list. It uses the bot's configured model.
Enabling starts one review immediately. If the computer is off at the scheduled time, the
durable scheduler catches up after the worker starts again; missed days become one review,
then the next run returns to 18:00. This does not wake a powered-off computer.

This restricted run can only read memory, search it and propose a smaller summary. It must read
every page of the current source version first. Proposals keep exact original line ranges, source
versions and a complete source snapshot in `memory/reviews/`. Review these as ordinary memory
documents in the human interface. Agent tools cannot read or overwrite these reserved artifacts.
Proposals must save at least 512 Unicode characters of source text; this is a usefulness threshold,
not a semantic safety guarantee. Existing review artifacts are preserved.
The task cannot overwrite the source, run commands, call integrations or create schedules.
No candidate, a missing model or a failed validation leaves the summary unchanged.

The operator CLI is `apps/api/dist/cli/memory-maintenance.js`: `plan-nightly` previews setup,
`enable-nightly` creates missing routines without reactivating paused ones, `backfill-search`
updates derived search fields, and `verify-search` compares indexed results with complete scans.
Back up the database before migrating or backfilling. Backfill preserves content, revisions and
timestamps and skips concurrent changes.

After deploying an index migration, or returning from an older release, run `check-search`.
It reads index-version counts, emits no memory text, and exits with status 2 if any document
needs indexing. With a verified backup, explicitly run `backfill-search`, then repeat `check-search`
and `verify-search`. Recheck after concurrent writes or backfill conflicts.
An old writer can invalidate index tokens; search stays correct through decrypted fallback.
Applications do not migrate or backfill memory on startup. Deployment must not be considered
verified until these explicit checks pass.

## Memory providers

Optionally, connect a memory service so bots can also recall facts by meaning, not just by reading
their notes. In **Settings → Memory**, choose **Connect memory provider**:

- **Supermemory**: its cloud service, or your own instance.
- **Serenity**: choose **Recall and write**, or **Recall only** to keep it read-only.
- **Honcho**: reads from an existing Honcho peer and never writes to it.

Once connected, **Default scope** decides what bots share in the provider:

- **Isolated**: each bot recalls only what it saved. This is the default.
- **Shared**: bots in the space recall from one pool.

Each bot's settings also gain a **Memory scope** under **Advanced**, so one bot can differ from the
default.

## Open work

Separate from memory, each bot keeps a short list of **Open work**: things it has started and not
finished. It is in the bot's settings. You can add items for it, or mark them complete.

## Memory across spaces

Memory never crosses [spaces](./spaces.md). A bot in one space can't read notes from another.
