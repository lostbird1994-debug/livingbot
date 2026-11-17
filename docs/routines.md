# Routines

A routine is a prompt a bot runs on its own: on a schedule, when something changes, or when another
service calls it.

## Ask for one in chat

The quickest way is to ask:

- "Every weekday at 8am, summarize my inbox."
- "Remind me in 20 minutes to call Dana."
- "Every Monday, check our competitors' pricing pages and tell me what changed."

The bot creates the routine and reports each run back in the same chat.

## Create or edit one yourself

Open the bot's computer with **Agent computer** at the top of the chat. Below the screen is the
bot's **Routines** list. Choose **Create Routine** (the **+**), or click a routine to edit it.

1. **Name** the routine and write the **Instruction**: what it should do each time it runs.
2. Under **When to run**, choose **Add trigger**.
3. Choose **Save**.

Under **Advanced** you can give a routine its own **Model** and **Thinking** level, for example a
cheaper model for a simple daily check.

## Triggers

### On a schedule

Every hour, every day, weekdays, every week, every month, or a custom interval. **Advanced...**
accepts a cron expression. Times use your timezone, set in **Settings → General**.

### When something changes

The bot checks something at a set interval (**Check every**, from 5 minutes to a day) and runs only
when it changed. **What to watch** can be files or folders on the computer, a command's output, or a
tool from a connected app. Turn on **Post "No changes" in chat** if you want a note every time. A
watch can't be combined with a schedule.

### Webhook

Gives you a URL and key. Any service that can send a POST request can start the routine.

### Git event

Gives you a URL to add as a GitHub webhook, so pushes, issues and pull requests can start the
routine.

### Slack message

Runs when the bot receives a message in Slack. Needs [Slack connected](./messaging-apps.md).

> [!NOTE]
> Runs started by a webhook or an outside message follow stricter [approval](./approvals.md) rules,
> since outside text could steer what the bot does.

## Test, pause and review

- **Test run** runs a saved routine now.
- Turn off **Active** to pause a routine without deleting it.
- **Run history** shows each past run and its result.
- A running routine shows **Running** in the list, with **Stop**.

## On mobile

The mobile app lists a bot's routines from its profile. You can pause, delete and review them there.
To create or change one, ask the bot in chat or use the web or desktop app.

## Built-in routines

Every bot has **Daily review**, **Automatic memory organization** **Context audit**, and **Daily workspace organization**. Users can enable or disable
these routines; their instructions and triggers are product-owned, and they cannot be deleted,
renamed, retimed, run manually, or invoked through a routine mention. These restrictions apply to
the API and agent scheduling tools as well as web, desktop and mobile controls.

Missing daily review, memory organization and workspace organization routines are created disabled when a bot is created or its routines are opened. Existing
memory-maintenance routines retain their enabled state. System schedules follow the account timezone. Custom routines remain
separate; a similarly named custom routine is not automatically converted or removed.

The three daily system routines run only if this bot has a direct human message today in its
main chat or an independent conversation. The backend checks the current date in the routine's
account timezone before creating work. Bot replies, system task output, external transcripts and
other bots' conversations do not qualify. An inactive day advances the next scheduled occurrence
without calling a model, posting a message, writing files or changing the last-run time; only an
internal skip log is recorded. A delayed wakeup checks the actual execution day, rather than the
missed day. Custom routines and message-count context audits keep their own triggers.

Daily review checks at 18:00 in the account's timezone. Without new terminal human work it skips
the model. It processes a fixed batch of up to eight completed or failed direct human runs at a
time, retaining their requests, replies and tool receipts as evidence. Every page must be read
before acknowledging a batch. Acknowledgment advances progress only when the review run finishes
successfully. Larger backlogs continue in batches with the same cutoff; missed calendar days do
not create separate retrospective reports. Runs arriving after that cutoff wait for the next
review. Review cannot send messages, execute commands, use integrations, schedule work, change bot
instructions, or delete memory. No new durable information is a valid reason to write nothing.

Memory organization checks at 18:10 and Daily workspace organization checks at 18:20.
These fixed schedules do not advance after human messages or completed reviews. Only one built-in maintenance run
per bot is dispatched at a time, coordinated across workers; other bots remain independent.
See [Memory](./memory.md) for organization triggers and source-preservation guarantees.

## Context audit

**Context audit** is a built-in prompt with a usage trigger rather than a calendar schedule.
It is enabled by default. Enabling it starts counting new direct human messages for that bot;
retries of the same source message count once, and bot/system messages and external-channel
work do not count. After 50 messages, the next completed or failed human turn creates a question
in the bot's private conversation without calling a model. Only one question remains pending.

The owner can choose **开始审计** or **暂不**. Starting queues the audit with its built-in prompt;
declining closes that reminder without a model call. Either answer starts the next count from
the answer time. Disabling and re-enabling also starts a new count. A pending question does not
block daily review or memory organization.

The audit reads the same loading-preview implementation as the **Context** tab, starting with
its automatic context documents, then following relevant skills and notes. Its tools are limited
to reading context, memory, skills and files. It reports findings in the conversation, distinguishes
confirmed issues from judgments and unknowns, and preserves the distinction between accessible,
automatically loaded and demonstrably referenced content. It cannot change files, settings or
memory, run commands, call integrations, or carry out its own cleanup recommendations. Cleanup
requires a separate user-approved task.


Daily workspace organization is a system routine alongside the other built-ins. Existing workspace
organization schedules and run history are adopted in place on an explicit upgrade. Its shared
prompt maintains local file structure and operating notes, preserves originals and references,
and restricts obsolete-file cleanup to recoverable Trash moves. It cannot contact integrations,
send messages or rewrite the bot's instructions, skills or system-managed memory.
All built-ins show a **System** label; message-count triggers appear under **Non-time conditions**.
Existing explicit user toggles remain unchanged by ordinary provisioning.
