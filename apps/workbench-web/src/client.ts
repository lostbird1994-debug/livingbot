import type { Artifact, FileBatchInput, FileBatchReceipt, GroupInput, GroupReceipt, Interaction, Message, ProductEvent, Snapshot, Task } from "../../../packages/workbench/src/contracts.ts";
import type { InteractionAnswer } from "../../../packages/workbench/src/interactions.ts";

export type WorkbenchSnapshot = Snapshot & { kernel: { phase: string } };

export class WorkbenchClient {
  readonly origin: string;
  private readonly token: string;

  constructor(origin: string, token: string) {
    const target = new URL(origin);
    if (target.origin !== location.origin && !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
      throw new Error("请选择本机服务");
    }
    this.origin = target.origin;
    this.token = token;
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(String(result.error ?? "请求失败"));
    return result as T;
  }

  snapshot(): Promise<WorkbenchSnapshot> { return this.request("/api/snapshot"); }
  messages(id: string): Promise<{ messages: Message[]; cursor: number }> {
    return this.request(`/api/conversations/${encodeURIComponent(id)}/messages`);
  }
  send(input: { submissionId: string; conversationId: string; botId: string; message: string; attachmentIds?: string[]; queueMode?: "followup" | "steer" }): Promise<Task> {
    return this.request("/api/submissions", input);
  }
  sendGroup(input: GroupInput): Promise<GroupReceipt> { return this.request("/api/group-submissions", input); }
  sendFileBatch(input: FileBatchInput): Promise<FileBatchReceipt> { return this.request("/api/file-batches", input); }
  retryFileBatch(id: string, retryId: string): Promise<FileBatchReceipt> {
    return this.request(`/api/file-batches/${encodeURIComponent(id)}/retry`, { retryId });
  }
  async upload(input: { id: string; conversationId: string; botId: string; file: File }): Promise<Artifact> {
    const query = new URLSearchParams({ botId: input.botId, name: input.file.name, mediaType: input.file.type || "application/octet-stream" });
    const response = await fetch(`${this.origin}/api/conversations/${input.conversationId}/attachments/${input.id}?${query}`, {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" },
      body: input.file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "文件上传失败");
    return result as Artifact;
  }
  async file(id: string): Promise<Blob> {
    const response = await fetch(`${this.origin}/api/files/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "文件读取失败");
    return response.blob();
  }
  cancel(id: string): Promise<Task> { return this.request(`/api/tasks/${encodeURIComponent(id)}/cancel`, {}); }
  continueTask(id: string, submissionId: string): Promise<Task> {
    return this.request(`/api/tasks/${encodeURIComponent(id)}/continue`, { submissionId });
  }
  resolveInteraction(taskId: string, id: string, answer: InteractionAnswer): Promise<Interaction> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/interactions/${encodeURIComponent(id)}/resolve`, answer);
  }

  /** Fetch-based SSE keeps the token out of URLs and supports a durable cursor. */
  async events(after: number, signal: AbortSignal, receive: (event: ProductEvent) => void, onConnected?: () => void): Promise<void> {
    const response = await fetch(`${this.origin}/api/events?after=${after}`, {
      headers: { authorization: `Bearer ${this.token}` }, signal,
    });
    if (!response.ok || !response.body) throw new Error("事件连接失败");
    onConnected?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data) receive(JSON.parse(data) as ProductEvent);
        }
      }
    } finally { reader.releaseLock(); }
  }
}
