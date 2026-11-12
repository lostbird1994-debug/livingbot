import * as z from "zod";

export const ConversationFindFilters = z.object({
  mode: z.enum(["messages", "files"]),
  query: z.string().max(200).default(""),
  sender: z.enum(["all", "user", "bot"]).default("all"),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  fileType: z.enum(["all", "document", "spreadsheet", "image", "other"]).default("all"),
  before: z.number().int().nonnegative().optional(),
});
const common = {
  id: z.string(),
  messageId: z.string(),
  seq: z.number().int(),
  role: z.enum(["user", "bot"]),
  senderName: z.string(),
  createdAt: z.iso.datetime(),
};
export const ConversationFindItem = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("message"), snippet: z.string() }),
  z.object({
    ...common,
    kind: z.literal("file"),
    name: z.string(),
    mimeType: z.string(),
    size: z.number().nonnegative().optional(),
    artifactId: z.string().optional(),
    path: z.string().optional(),
  }),
]);
export type ConversationFindItem = z.infer<typeof ConversationFindItem>;
export type ConversationFindFilters = z.infer<typeof ConversationFindFilters>;
export const ConversationFindPage = z.object({
  items: z.array(ConversationFindItem),
  nextBefore: z.number().int().nonnegative().nullable(),
});
