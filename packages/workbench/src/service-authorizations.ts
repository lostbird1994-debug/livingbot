import type {
  AuthorizationAttempt, AuthorizationProvider, McpAuthorization,
} from "../../kernel-runtime/src/authorizations.ts";
import type { WorkbenchStore } from "./store.ts";

/** The last state OpenClaw itself reported, plus when this product read it. */
export type ServiceAuthorizationView = McpAuthorization & { checkedAt: number };

type Receipt = ServiceAuthorizationView & { id: string };

const receiptPrefix = "service-authorization:";

/**
 * Account consent is global, like the connection it belongs to, and its state
 * is only ever what the kernel reported. Reading is explicit: no timer.
 */
export class ServiceAuthorizations {
  private readonly store: WorkbenchStore;
  private readonly provider: AuthorizationProvider;

  constructor(store: WorkbenchStore, provider: AuthorizationProvider) {
    this.store = store; this.provider = provider;
  }

  /** One authoritative read; also records the receipt each view came from. */
  async read(): Promise<ServiceAuthorizationView[]> {
    const items = await this.provider.read();
    const checkedAt = Date.now();
    return this.store.transaction(() => items.map((item) => {
      const receipt: Receipt = { ...item, checkedAt, id: `${receiptPrefix}${item.name}` };
      this.store.put("settings", receipt);
      return { ...item, checkedAt };
    }));
  }

  /** Persisted receipts: what was confirmed, without asking the kernel again. */
  receipts(): ServiceAuthorizationView[] {
    return this.store.list<Receipt>("settings")
      .filter((item) => item.id.startsWith(receiptPrefix))
      .map(({ id, ...view }) => view)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  start(name: string): Promise<AuthorizationAttempt> {
    return this.provider.start(name);
  }

  attempt(id: string): AuthorizationAttempt | undefined {
    return this.provider.attempt(id);
  }

  wait(id: string, timeoutMs: number): Promise<AuthorizationAttempt | undefined> {
    return this.provider.wait(id, timeoutMs);
  }

  /**
   * Cancelling stops the pending native process, but the kernel keeps the
   * half-finished authorization it had already recorded. Clear that too, so the
   * connection returns to "not signed in" instead of staying "pending".
   */
  async cancel(id: string): Promise<void> {
    const attempt = await this.provider.wait(id, 0);
    await this.provider.cancel(id);
    if (attempt && attempt.state !== "authorized") {
      // A failed cleanup must not turn a successful cancel into an error; the
      // next authoritative read still reports whatever is actually true.
      await this.provider.revoke(attempt.name).catch(() => undefined);
    }
  }

  async complete(name: string, code: string, issuer?: string): Promise<ServiceAuthorizationView> {
    const item = await this.provider.complete(name, code, issuer);
    return this.record(item);
  }

  async revoke(name: string): Promise<ServiceAuthorizationView> {
    const item = await this.provider.revoke(name);
    return this.record(item);
  }

  async dispose(): Promise<void> {
    await this.provider.dispose?.();
  }

  private record(item: McpAuthorization): ServiceAuthorizationView {
    const checkedAt = Date.now();
    const receipt: Receipt = { ...item, checkedAt, id: `${receiptPrefix}${item.name}` };
    this.store.put("settings", receipt);
    return { ...item, checkedAt };
  }
}
