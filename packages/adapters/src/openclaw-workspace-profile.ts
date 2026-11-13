import { relative, resolve, sep } from "node:path";
import type { AdapterContext } from "@livingbot/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@livingbot/adapter-kit";
import { botRoleCard } from "@livingbot/contracts";
import type { PrismaClient } from "@livingbot/db";
import { commitBotUpdate } from "@livingbot/db";
import type { OpenClawKernelRegistry } from "./openclaw-kernel-registry.js";
import { nativeWorkspacePath, readNativeWorkspaceFile, writeNativeWorkspaceFile } from "./openclaw-workspace-files.js";

type Actor = Pick<AdapterContext, "spaceId" | "userId">;
export interface BotWorkspaceProfiles {
  refresh(actor: Actor, botId: string): Promise<void>;
  resolveDocument?(actor: Actor, reference: string): Promise<string | undefined>;
  resolveSourceDocument?(actor: Actor, botId: string, reference: string): Promise<string | undefined>;
  updateDocument?(actor: Actor, input: { botId: string; scope: "bot" | "user"; name: string; content: string; expectedContent: string }): Promise<void>;
  /** Refresh first, then preserve native preimages while applying a checked host update. */
  edit<T>(actor: Actor, botId: string, update: () => Promise<T>): Promise<T>;
}
export class OpenClawWorkspaceProfiles implements BotWorkspaceProfiles {
  constructor(private options: {
    prisma: PrismaClient;
    registry: OpenClawKernelRegistry;
    withLock<T>(key: string, work: () => Promise<T>): Promise<T>;
    notify(threadId: string, seq: number): Promise<void>;
  }) {}

  private async current(actor: Actor, botId: string) {
    const [entry, bot] = await Promise.all([
      this.options.registry.entry(botId, actor),
      this.options.prisma.bot.findFirstOrThrow({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true, instructions: true, roleCard: true, thread: { select: { id: true } } },
      }),
    ]);
    const [identity, personality, instructions, userIdentity] = await Promise.all(
      ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md"].map(name => readNativeWorkspaceFile(entry.workspace, name)),
    );
    return {
      bot, entry,
      files: { "IDENTITY.md": identity, "SOUL.md": personality, "AGENTS.md": instructions, "USER.md": userIdentity },
      instructions: instructions ?? "",
      roleCard: { ...botRoleCard(bot.roleCard), identity: identity ?? "", personality: personality ?? "",
        userIdentity: userIdentity ?? "", userIdentityEnabled: false, backstoryEnabled: false },
    };
  }

  private async refreshUnlocked(actor: Actor, botId: string) {
    const current = await this.current(actor, botId);
    if (!current.bot.thread) throw new Error("Native bot has no host conversation");
    const changedRole = JSON.stringify(botRoleCard(current.bot.roleCard)) !== JSON.stringify(current.roleCard);
    const changedInstructions = current.bot.instructions !== current.instructions;
    if (changedRole || changedInstructions) {
      await commitBotUpdate({
        prisma: this.options.prisma, notify: this.options.notify,
        spaceId: actor.spaceId, threadId: current.bot.thread.id, botId,
        data: {
          ...(changedInstructions ? { instructions: current.instructions } : {}),
          ...(changedRole ? { roleCard: current.roleCard } : {}),
        },
        expectedInstructions: current.bot.instructions,
        expectedRoleCard: botRoleCard(current.bot.roleCard),
        emitBotUpdated: true, reason: "Native workspace update",
      });
    }
    return current;
  }

  async refresh(actor: Actor, botId: string) {
    await this.options.withLock(JSON.stringify(["native-profile", actor.spaceId, actor.userId, botId]),
      async () => { await this.refreshUnlocked(actor, botId); });
  }

  async resolveSourceDocument(actor: Actor, botId: string, reference: string): Promise<string | undefined> {
    try {
      const entry = await this.options.registry.entry(botId, actor);
      // Use the same path rules as attachment reads. No basename search or
      // fallback into another bot's workspace or a downloaded copy.
      const name = relative(resolve(entry.workspace), resolve(entry.workspace, reference)).split(sep).join("/");
      return await nativeWorkspacePath(entry.workspace, name);
    } catch { return; }
  }

  async resolveDocument(actor: Actor, reference: string): Promise<string | undefined> {
    const match = reference.match(/(?:^|\/)bots\/([a-zA-Z0-9_-]+)\/(.+)$/);
    if (!match) return;
    try {
      // The registry verifies both owner and workspace; never search by basename.
      const entry = await this.options.registry.entry(match[1]!, actor);
      return await nativeWorkspacePath(entry.workspace, match[2]!);
    } catch { return; }
  }

  async updateDocument(actor: Actor, input: {
    botId: string; scope: "bot" | "user"; name: string; content: string; expectedContent: string;
  }) {
    const allowed = input.scope === "user" ? ["USER.md", "MEMORY.md"] :
      ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
    if (!allowed.includes(input.name)) throw new Error("Unsupported context document");
    await this.options.withLock(JSON.stringify(["native-profile", actor.spaceId, actor.userId, input.botId]), async () => {
      const entry = await this.options.registry.entry(input.botId, actor);
      await writeNativeWorkspaceFile(input.scope === "user" ? entry.sharedWorkspace : entry.workspace,
        input.name, input.content, input.expectedContent);
      if (input.scope === "bot" && ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md"].includes(input.name))
        await this.refreshUnlocked(actor, input.botId);
    });
  }

  async edit<T>(actor: Actor, botId: string, update: () => Promise<T>): Promise<T> {
    return this.options.withLock(JSON.stringify(["native-profile", actor.spaceId, actor.userId, botId]), async () => {
      const before = await this.refreshUnlocked(actor, botId);
      const result = await update();
      const bot = await this.options.prisma.bot.findFirstOrThrow({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        select: { instructions: true, roleCard: true },
      });
      const card = botRoleCard(bot.roleCard);
      const updates = [
        ["IDENTITY.md", card.identity, before.roleCard.identity],
        ["SOUL.md", card.personality, before.roleCard.personality],
        ["AGENTS.md", bot.instructions, before.instructions],
        ["USER.md", card.userIdentity, before.roleCard.userIdentity],
      ] as const;
      const changed = updates.filter(([, content, old]) => content !== old);
      try {
        // Check the entire proposal before writing any module. Native files remain authoritative.
        for (const [name] of changed) {
          if (await readNativeWorkspaceFile(before.entry.workspace, name) !== before.files[name])
            throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
        }
        for (const [name, content] of changed)
          await writeNativeWorkspaceFile(before.entry.workspace, name, content, before.files[name]);
      } catch (error) {
        // Publish the real saved state, including any concurrent engine edit or partial save.
        // Preimages and the proposed database revision remain recoverable.
        try { await this.refreshUnlocked(actor, botId); }
        catch (reconcileError) {
          throw new AggregateError([error, reconcileError], "Native profile save and reconciliation failed");
        }
        throw error;
      }
      return result;
    });
  }
}
