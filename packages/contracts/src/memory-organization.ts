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
