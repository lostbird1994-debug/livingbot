import type { ConversationFindFilters } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findConversationHistory } from "./conversation-find.js";

const actor = { userId: "owner", spaceId: "space" } as never;
const input: ConversationFindFilters = {
  mode: "messages",
  query: "目标",
  sender: "all",
  fileType: "all",
};
function message(
  seq: number,
  blocks: unknown[] = [{ kind: "text", text: "目标内容" }],
  role = "bot",
) {
  return {
    id: `m-${seq}`,
    threadId: "thread",
    seq,
    role,
    botId: role === "bot" ? "bot" : null,
    blocks,
    createdAt: new Date(`2026-01-${String((seq % 28) + 1).padStart(2, "0")}T00:00:00Z`),
  };
}
function fixture(rows: ReturnType<typeof message>[]) {
  const findMany = vi.fn(async ({ where, take }: any) =>
    rows
      .filter(
        (r) =>
          r.threadId === where.threadId &&
          (!where.seq || r.seq < where.seq.lt) &&
          (typeof where.role === "string"
            ? r.role === where.role
            : where.role.in.includes(r.role)) &&
          (!where.createdAt?.gte || r.createdAt >= where.createdAt.gte) &&
          (!where.createdAt?.lte || r.createdAt <= where.createdAt.lte),
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, take),
  );
  const db = {
    message: { findMany },
    bot: { findMany: vi.fn(async () => [{ id: "bot", name: "Test Bot" }]) },
  } as unknown as PrismaClient;
  return {
    findMany,
    run: (patch: Partial<ConversationFindFilters> = {}) =>
      findConversationHistory(db, actor, "thread", { ...input, ...patch }),
  };
}
describe("conversation history lookup", () => {
  it("scopes every decrypted page to the authorized thread, owner and space", async () => {
    const f = fixture([message(1)]);
    const p = await f.run();
    expect(p.items).toMatchObject([{ messageId: "m-1", senderName: "Test Bot", role: "bot" }]);
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "thread",
          thread: { spaceId: "space", userId: "owner" },
        }),
      }),
    );
  });
  it("keeps old history searchable beyond the initial scan, with no false empty end", async () => {
    const rows = Array.from({ length: 1101 }, (_, i) =>
      message(i + 1, [{ kind: "text", text: i === 0 ? "目标" : "无关消息" }]),
    );
    const f = fixture(rows);
    const first = await f.run();
    expect(first.items).toEqual([]);
    expect(first.nextBefore).not.toBeNull();
    const next = await f.run({ before: first.nextBefore! });
    expect(next.items).toMatchObject([{ messageId: "m-1" }]);
    expect(next.nextBefore).toBeNull();
  });
  it("retains separate same-name versions and both directions, ignoring raw tool payloads", async () => {
    const file = (id: string) => ({
      kind: "file",
      artifactId: id,
      name: "报告.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 20,
    });
    const f = fixture([
      message(3, [file("new")]),
      message(2, [file("old")], "user"),
      message(1, [{ kind: "step", name: "exec", result: "目标秘密" }]),
    ]);
    const p = await f.run({ mode: "files", query: "报告" });
    expect(p.items.map((x) => (x.kind === "file" ? x.artifactId : null))).toEqual(["new", "old"]);
    expect((await f.run({ query: "秘密" })).items).toEqual([]);
    expect((await f.run({ mode: "files", query: "报告", sender: "user" })).items).toMatchObject([
      { role: "user", senderName: "我" },
    ]);
  });
  it("does not split a multi-file message across cursors or lose its last attachment", async () => {
    const files = Array.from({ length: 35 }, (_, i) => ({
      kind: "file",
      artifactId: `a-${i}`,
      name: `file-${i}.txt`,
      mimeType: "text/plain",
      size: 10,
    }));
    const f = fixture([message(2, files), message(1)]);
    const p = await f.run({ mode: "files", query: "" });
    expect(p.items).toHaveLength(35);
    expect(p.nextBefore).toBe(2);
  });
  it("includes images and exact local references, filters by type, and deduplicates only exact repeats", async () => {
    const f = fixture([
      message(1, [
        { kind: "image", artifactId: "img", name: "照片.png", mimeType: "image/png" },
        {
          kind: "text",
          text: "MEDIA:/work/report.docx\n`/work/report.docx`\n/work/other/report.docx",
        },
      ]),
    ]);
    expect((await f.run({ mode: "files", query: "", fileType: "image" })).items).toMatchObject([
      { artifactId: "img" },
    ]);
    const p = await f.run({ mode: "files", query: "", fileType: "document" });
    expect(p.items).toHaveLength(2);
  });
  it("uses inclusive timestamps and refuses an inverted date range", async () => {
    const f = fixture([message(1), message(2)]);
    expect(
      (await f.run({ from: "2026-01-02T00:00:00Z", to: "2026-01-02T23:59:59Z" })).items,
    ).toMatchObject([{ messageId: "m-1" }]);
    await expect(
      f.run({ from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

it("returns readable message summaries without Markdown syntax", async () => {
  const f = fixture([
    message(1, [{ kind: "text", text: "**目标已完成**，请看[报告](/work/report.docx)。" }]),
  ]);
  const page = await f.run();
  expect(page.items[0]).toMatchObject({ kind: "message", snippet: "目标已完成，请看报告。" });
});
