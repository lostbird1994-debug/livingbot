import { MessageBlock as MessageBlockSchema } from "@livingbot/contracts";

/** Only a persisted choice answer can authorize an external approval. */
export function readAnsweredNativeApproval(
  blocks: unknown,
): { id: string; actionId: string } | undefined {
  const parsed = MessageBlockSchema.array().safeParse(blocks);
  if (!parsed.success) return undefined;
  const ask = parsed.data.findLast((block) => block.kind === "ask");
  if (ask?.kind !== "ask" || !ask.ownerOnly || !ask.approvalRequestId || ask.status !== "answered")
    return undefined;
  if (ask.externalRequestKind === "question" && ask.answer?.trim() && ask.answer.length <= 64_000)
    return { id: ask.approvalRequestId, actionId: ask.answer };
  if (
    !ask.answer ||
    !["allow-once", "deny"].includes(ask.answer) ||
    !ask.actions?.some((action) => action.id === ask.answer)
  )
    return undefined;
  return { id: ask.approvalRequestId, actionId: ask.answer };
}
