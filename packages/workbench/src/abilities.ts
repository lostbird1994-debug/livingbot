import type { CapabilityProvider, KernelCapability } from "../../kernel-runtime/src/capabilities.ts";
import type { Ability, Bot, Conversation } from "./contracts.ts";
import type { WorkbenchStore } from "./store.ts";
import type { PackageUpdate } from "./marketplace.ts";

/** One product inventory; native configuration owns actual execution access. */
export class Abilities {
  private readonly store: WorkbenchStore;
  private readonly provider: CapabilityProvider;
  private readonly pending = new Map<string, Promise<Ability[]>>();
  private readonly admissions = new Map<string, Promise<unknown>>();
  private sharedPending?: Promise<Ability[]>;

  constructor(store: WorkbenchStore, provider: CapabilityProvider) {
    this.store = store; this.provider = provider;
  }

  private sharedCapability(ability: Ability): KernelCapability | undefined {
    const native = ability.configuration?.native as Partial<KernelCapability> | undefined;
    const access = ability.configuration?.sharedAccess as NonNullable<Ability["access"]>[string] | undefined;
    if (!native?.global || !native.id || !native.nativeName || !native.nativeKind || !access) return undefined;
    return {
      ...native, id: native.id, nativeName: native.nativeName, nativeKind: native.nativeKind,
      name: ability.name, description: ability.description,
      kind: ability.kind === "method" ? "method" : ability.kind === "service" ? "service" : "tool",
      source: ability.source, ...access,
    };
  }

  async listShared(): Promise<Ability[]> {
    if (!this.provider.readGlobal) throw new Error("Native shared capability management is unavailable");
    const known = this.store.list<Ability>("abilities").flatMap((ability) => {
      const capability = this.sharedCapability(ability);
      return capability ? [capability] : [];
    });
    const capabilities = await this.provider.readGlobal(known);
    const botIds = this.store.list<Bot>("bots").map((bot) => bot.id);
    const abilities = capabilities.map((capability): Ability => {
      const { enabled, ready, manageable, reason } = capability;
      const sharedAccess = { enabled, ready, manageable, ...(reason ? { reason } : {}) };
      return {
        id: `native:global:${capability.id}`, name: capability.name, description: capability.description,
        kind: capability.kind, source: capability.source, version: "native", permissions: [],
        botIds: enabled ? botIds : [], state: enabled ? "enabled" : "disabled",
        configuration: {
          sharedAccess,
          native: {
            id: capability.id, nativeName: capability.nativeName, nativeKind: capability.nativeKind,
            nativeSource: capability.nativeSource ?? capability.source,
            nativeDescription: capability.nativeDescription ?? capability.description,
            ...(capability.skillKey ? { skillKey: capability.skillKey } : {}),
            ...(capability.bundled !== undefined ? { bundled: capability.bundled } : {}),
            owner: capability.nativeKind === "service" ? capability.nativeName : capability.source, global: true,
          },
        },
      };
    });
    this.store.transaction(() => {
      for (const ability of abilities) this.store.put("abilities", ability);
    });
    return abilities;
  }

  refreshShared(): Promise<Ability[]> {
    if (this.sharedPending) return this.sharedPending;
    const refresh = async () => {
      if (!this.provider.refreshGlobal) throw new Error("Native shared capability refresh is unavailable");
      await this.provider.refreshGlobal();
      await this.inheritServices();
      return this.listShared();
    };
    this.sharedPending = this.exclusive("shared-abilities", refresh).finally(() => { this.sharedPending = undefined; });
    return this.sharedPending;
  }

  async setSharedEnabled(id: string, enabled: boolean): Promise<Ability[]> {
    if (!this.provider.setGlobalEnabled) throw new Error("Native shared capability management is unavailable");
    await this.sharedPending;
    return this.exclusive("shared-abilities", async () => {
      const current = await this.listShared();
      const ability = current.find((item) => item.id === id);
      const capability = ability && this.sharedCapability(ability);
      if (!capability) throw new Error("Unknown shared ability");
      if (!capability.manageable) throw new Error("This ability is controlled by shared settings");
      await this.provider.setGlobalEnabled!(capability, enabled);
      await this.inheritServices();
      const refreshed = await this.listShared();
      const applied = refreshed.find((item) => item.id === id);
      if (!applied || this.sharedCapability(applied)?.enabled !== enabled) {
        throw new Error("公共能力配置尚未确认，请刷新后重试");
      }
      return refreshed;
    });
  }

  refresh(botId: string): Promise<Ability[]> {
    const previous = this.pending.get(botId);
    if (previous) return previous;
    const operation = this.exclusive(botId, () => this.read(botId)).finally(() => this.pending.delete(botId));
    this.pending.set(botId, operation);
    return operation;
  }

  private bot(id: string): Bot {
    const bot = this.store.get<Bot>("bots", id);
    if (!bot) throw new Error("Unknown Bot");
    return bot;
  }

  private exclusive<T>(botId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.admissions.get(botId);
    const next = previous ? previous.catch(() => {}).then(action) : action();
    this.admissions.set(botId, next);
    void next.finally(() => {
      if (this.admissions.get(botId) === next) this.admissions.delete(botId);
    }).catch(() => {});
    return next;
  }

  private services(botId: string): Record<string, boolean> {
    return this.store.get<{ id: string; services: Record<string, boolean> }>("settings", `service-access:${botId}`)?.services ?? {};
  }

  private async inheritServices(): Promise<void> {
    const settings = this.store.list<{
      id: string; services?: Record<string, boolean>; sharedInheritance?: boolean;
    }>("settings").filter((item) => item.id.startsWith("service-access:") &&
      Object.keys(item.services ?? {}).length);
    if (settings.length && !this.provider.prepareServices) throw new Error("Native service permissions are unavailable");
    const results = await Promise.allSettled(settings.map(async (setting) => {
      const botId = setting.id.slice("service-access:".length);
      const bot = this.store.get<Bot>("bots", botId);
      if (!bot) return;
      await this.exclusive(botId, async () => {
        const current = this.services(botId);
        const services = Object.fromEntries(Object.keys(current).map((name) => [name, true]));
        // Persist the cleanup intent first. After a failed write or a restart,
        // admission retries removing these old overrides before starting work.
        // Native true here means remove the override, even if globally disabled.
        this.store.put("settings", { ...setting, services, sharedInheritance: true });
        const targets = this.store.list<Conversation>("conversations").filter((item) => item.botIds.includes(botId));
        const results = await Promise.allSettled(targets.map((target) =>
          this.provider.prepareServices!(bot.agentId, this.store.engineSessionKey(target.id, botId), services)));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  /** Serialize only this Bot's admission against its own permission edits. */
  withChanges<T>(botId: string, action: () => Promise<T>): Promise<T> {
    this.bot(botId);
    return this.exclusive(botId, action);
  }

  withAccess<T>(botId: string, sessionKey: string, send: () => Promise<T>): Promise<T> {
    return this.exclusive(botId, async () => {
      const unfinishedUpdate = this.store.list<PackageUpdate>("settings").some((item) =>
        item.id.startsWith("package-update:") && item.previous.botId === botId && item.state !== "ready");
      if (unfinishedUpdate) throw new Error("伙伴能力更新未完成，请先重试更新");
      const policy = this.services(botId);
      if (Object.keys(policy).length) {
        if (!this.provider.prepareServices) throw new Error("Native service permissions are unavailable");
        await this.provider.prepareServices(this.bot(botId).agentId, sessionKey, policy);
      }
      return send();
    });
  }

  private async read(botId: string): Promise<Ability[]> {
    const bot = this.bot(botId);
    const conversation = this.store.privateConversation(botId);
    const policy = this.services(botId);
    if (Object.keys(policy).length && this.provider.prepareServices) {
      await this.provider.prepareServices(bot.agentId, this.store.engineSessionKey(conversation.id, botId), policy);
    }
    const known: KernelCapability[] = [];
    for (const ability of this.store.list<Ability>("abilities")) {
      const access = ability.access?.[botId];
      const native = ability.configuration?.native as Partial<KernelCapability> | undefined;
      if (!access || !native?.id || !native.nativeName || !native.nativeKind) continue;
      known.push({
        id: native.id, nativeName: native.nativeName, nativeKind: native.nativeKind,
        name: ability.name, description: ability.description,
        kind: ability.kind === "method" ? "method" : ability.kind === "service" ? "service" : "tool",
        source: ability.source, ...access,
      });
    }
    const capabilities = await this.provider.read(bot.agentId, this.store.engineSessionKey(conversation.id, botId), known);
    return this.store.transaction(() => {
      const seen = new Set(capabilities.map((capability) => `native:${capability.id}`));
      for (const ability of this.store.list<Ability>("abilities")) {
        if (ability.access?.[botId] && !seen.has(ability.id)) {
          const access = { ...ability.access };
          delete access[botId];
          const botIds = ability.botIds.filter((id) => id !== botId);
          this.store.put("abilities", { ...ability, access, botIds, state: botIds.length ? "enabled" : "available" });
        }
      }
      return capabilities.map((capability) => {
        const id = `native:${capability.id}`;
        const previous = this.store.get<Ability>("abilities", id);
        const access = { ...previous?.access, [botId]: {
          enabled: capability.enabled, ready: capability.ready, manageable: capability.manageable,
          ...(capability.reason ? { reason: capability.reason } : {}),
        } };
        const botIds = Object.keys(access).filter((key) => access[key].enabled);
        return this.store.put<Ability>("abilities", {
          id, name: capability.name, description: capability.description, kind: capability.kind,
          source: capability.source, version: "native", permissions: [], access,
          botIds, state: botIds.length ? "enabled" : "available",
          configuration: { native: {
            id: capability.id, nativeName: capability.nativeName, nativeKind: capability.nativeKind,
          } },
        });
      });
    });
  }

  async setEnabled(id: string, botId: string, enabled: boolean): Promise<Ability[]> {
    await this.pending.get(botId);
    const bot = this.bot(botId);
    const ability = this.store.get<Ability>("abilities", id);
    if (this.provider.setGlobalEnabled && this.provider.readGlobal && ability) {
      const native = ability.configuration?.native as Partial<KernelCapability> | undefined;
      const shared = (await this.listShared()).find((item) => {
        const target = item.configuration?.native as Partial<KernelCapability> | undefined;
        return target?.nativeKind === native?.nativeKind && target?.nativeName === native?.nativeName &&
          (target?.nativeKind !== "tool" || item.source === ability.source);
      });
      if (!shared) throw new Error("Unknown shared ability");
      await this.setSharedEnabled(shared.id, enabled);
      return this.refresh(botId);
    }
    const access = ability?.access?.[botId];
    if (!ability || !access) throw new Error("Refresh this Bot's abilities before changing access");
    if (!access.manageable) throw new Error("This ability is controlled by shared settings");
    const native = ability.configuration?.native as Partial<KernelCapability> | undefined;
    if (!native?.id || !native.nativeName || !native.nativeKind) throw new Error("Ability has no native configuration");
    if (native.nativeKind === "service") {
      if (!this.provider.prepareServices) throw new Error("Native service permissions are unavailable");
      await this.exclusive(botId, async () => {
        const services = { ...this.services(botId), [native.nativeName!]: enabled };
        // Durable intent precedes native writes. A partial failure cannot allow
        // a newly admitted conversation to bypass the requested restriction.
        this.store.put("settings", { id: `service-access:${botId}`, services });
        const targets = this.store.list<Conversation>("conversations").filter((item) => item.botIds.includes(botId));
        const results = await Promise.allSettled(targets.map((target) =>
          this.provider.prepareServices!(bot.agentId, this.store.engineSessionKey(target.id, botId), services)));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    } else {
      const capability: KernelCapability = {
        ...native, id: native.id, nativeName: native.nativeName, nativeKind: native.nativeKind,
        name: ability.name, description: ability.description,
        kind: ability.kind === "method" ? "method" : ability.kind === "service" ? "service" : "tool",
        source: ability.source, ...access,
      };
      await this.exclusive(botId, () => this.provider.setEnabled(bot.agentId, capability, enabled));
    }
    const refreshed = await this.refresh(botId);
    const applied = refreshed.find((item) => item.id === id)?.access?.[botId];
    if (!applied || applied.enabled !== enabled) throw new Error("当前公共或会话策略未允许这项更改");
    return refreshed;
  }
}
