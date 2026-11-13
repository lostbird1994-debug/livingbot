import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeFrame, NativePeer, NativeRecord, NativeStore } from "./openclaw-native-driver.js";

/** Append-only encrypted state; gateway credentials never enter the journal. */
export class NativeRunJournal implements NativeStore {
  private readonly key: Buffer;
  constructor(private readonly root: string, secret: string) {
    if (!secret) throw new Error("External runtime state requires the existing encryption key");
    this.key = createHash("sha256").update(`rakazo-native-runtime/v1:${secret}`).digest();
  }
  private path(key: string) {
    return join(this.root, `${createHash("sha256").update(key).digest("hex")}.jsonl`);
  }
  async read(key: string): Promise<NativeRecord | undefined> {
    let raw: string;
    try { raw = await readFile(this.path(key), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const row = JSON.parse(raw.trimEnd().split("\n").at(-1)!);
    if (row.version !== 1) throw new Error("Unknown external runtime journal version");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.data, "base64")), decipher.final()]).toString());
  }
  async write(key: string, value: NativeRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(key));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    await appendFile(this.path(key), JSON.stringify({
      version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    }) + "\n", { mode: 0o600, flush: true });
  }
}

/** Trusted local kernel host only. Custom gateway methods can require admin scope
 * even without a model override. Never expose this peer or token to agent tools. */
export function connectOpenClawKernelSdk(
  url: string, token: string, onEvent: (event: NativeFrame) => void,
): Promise<NativePeer> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("Native kernel requires a trusted local gateway");
  return connectOpenClawSdk(url, token, onEvent, [
    "operator.read", "operator.write", "operator.approvals", "operator.admin",
  ]);
}

/** Optional SDK, loaded only for an explicitly configured OpenClaw connection. */
export async function connectOpenClawSdk(
  url: string, token: string, onEvent: (event: NativeFrame) => void,
  scopes = ["operator.read", "operator.write", "operator.approvals"],
): Promise<NativePeer> {
  const moduleName = "openclaw/plugin-sdk/gateway-runtime";
  const { GatewayClient } = await import(moduleName);
  return new Promise((resolve, reject) => {
    let ready = false;
    const client = new GatewayClient({
      url, token, clientName: "gateway-client", clientDisplayName: "LivingBot", clientVersion: "1",
      mode: "backend", role: "operator", scopes, caps: ["tool-events"], onEvent,
      onHelloOk() { ready = true; clearTimeout(timer); resolve(client); },
      onConnectError(error: Error) {
        if (!ready) {
          clearTimeout(timer); client.stop();
          reject(new Error(`OpenClaw authentication or connection failed: ${error.message}`));
        }
      },
    });
    const timer = setTimeout(() => {
      if (!ready) { client.stop(); reject(new Error("OpenClaw handshake timed out")); }
    }, 15_000);
    timer.unref?.();
    client.start();
  });
}
