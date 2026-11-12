import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const TaskSessionSchema = z.object({
  id: Id, botId: Id, threadId: Id, mainThreadId: Id, title: z.string(),
  modelProvider: z.string().nullable(), modelId: z.string().nullable(), thinkingLevel: z.string().nullable(),
  createdAt: IsoDate, updatedAt: IsoDate, archivedAt: IsoDate.nullable(),
  unread: z.boolean(), latestRunId: Id.nullable(), status: z.string(),
  resourceWaitReason: z.string().nullable(),
});
export type TaskSession = z.infer<typeof TaskSessionSchema>;
