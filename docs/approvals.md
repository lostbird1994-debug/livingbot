# Approvals

Decide how much a bot can do without asking you first.

## Choose a mode

Open **Settings → Approvals** and pick a **Mode**:

- **Ask**: the bot asks before any action that changes something, such as sending an email or
  editing a document. Reading usually doesn't ask.
- **Auto**: an approval model checks each action against what you asked for. Actions that fit go
  ahead; the bot asks when one is off-task, or can't be undone and you didn't ask for it.
- **Never ask**: every action runs without waiting.

**Auto** needs an **Approval model**, set in **Settings → Models**. See [Models](./models.md).

> [!TIP]
> Start with **Ask** or **Auto**. As you approve the same action again and again, choose
> **Always allow** on the card and the bot stops asking for that one.

## Approval cards

When a bot needs a yes, it posts a card in the chat showing exactly what it wants to do:

- **Allow once**: just this time.
- **Always allow this tool**, or **Always allow** a site: stop asking for it.
- **Deny**: the bot doesn't do it and carries on.

Cards never block the chat. Keep talking to the bot, and answer the card whenever you're ready. You
get a notification when a bot is waiting on you, if notifications are on in the bot's settings.

New cards carry a backend-resolved operation and reason. In the Chinese interface, the title and
explanation are Chinese. Schedule cards name the task, show requested changes and any newly
unapproved sites, and let you expand instruction changes. Known credentials are redacted. Older
cards can have their generic title localized, but missing historical details are not reconstructed.
Cards requiring a person omit the ineffective "Always allow this tool" choice.

## Allow and Block lists

Every **Always allow** choice is saved in **Settings → Approvals**. Switch any entry between
**Allow** and **Block**, or **Remove** it. A blocked action is refused without a card, in every
mode. **Preview** shows what would happen for a given tool before you change anything.

To stop one bot from ever using a tool, open the bot's settings, expand **Advanced**, and use
**Disable a tool** under **Tools**.

## What always asks

In **Auto** and **Ask**, these always show a card, and **Always allow** doesn't skip it:

- Changing a bot's instructions or model, and creating a space.
- Actions that text you didn't write could be steering, such as changes in a run started by a
  webhook.
- A routine that watches a command, or that names a site the run found in outside content.

Changing only an existing routine's timing does not trigger the new-site check. When updating a
routine, sites already in that routine's saved instructions remain trusted for that update, scoped
to the same owner, bot and space (and the same thread for group routines). Newly introduced,
unapproved sites still require confirmation after outside content has entered the run. This does
not grant account-wide site access or override a Block rule.

**Never ask** runs all of them. The one exception is accepting another owner's bot connection, which
it refuses when someone else started the run or outside content entered it.

## Per space

Approval settings are account defaults that every [space](./spaces.md) follows. To give one space
different rules, open its settings and choose **Customize** next to **Approvals**.
