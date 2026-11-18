import { z } from "zod";

export const MemoryOrganizationChangeSchema = z.object({
  tool: z.literal("organize_memory"),
  path: z.string(),
  status: z.enum(["applied", "failed"]),
  revision: z.number().int().optional(),
  sourceRevision: z.number().int().optional(),
  archive: z.string().optional(),
  savedCharacters: z.number().int().optional(),
  error: z.string().optional(),
});

/** Progress receipts written by the review itself; they are not document changes. */
export const MemoryOrganizationProgressSchema = z.object({
  tool: z.literal("memory_organization"),
  status: z.enum(["partial", "stalled"]),
  remaining: z.number().int().optional(),
});
