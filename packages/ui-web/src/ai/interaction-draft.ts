import type { InteractionAnswer } from "../../../workbench/src/contracts.ts";

export type InteractionDraft = {
  answers: Record<string, string[]>;
  other: Record<string, string>;
  pendingAnswer?: InteractionAnswer;
};

const prefix = "livingbot:interaction:";

/** Ordinary answers only; native secret questions never enter this UI. */
export function readInteractionDraft(id: string): InteractionDraft | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(`${prefix}${id}`) ?? "null");
    if (
      value?.version !== 1 ||
      !value.answers ||
      !value.other ||
      !Object.values(value.answers).every(
        (values) => Array.isArray(values) && values.every((item) => typeof item === "string"),
      ) ||
      !Object.values(value.other).every((item) => typeof item === "string") ||
      (value.pendingAnswer && typeof value.pendingAnswer.resolutionId !== "string")
    )
      return;
    return { answers: value.answers, other: value.other, pendingAnswer: value.pendingAnswer };
  } catch {
    return undefined;
  }
}

export function saveInteractionDraft(id: string, draft: InteractionDraft): void {
  try {
    sessionStorage.setItem(`${prefix}${id}`, JSON.stringify({ version: 1, ...draft }));
  } catch {
    /* The current tab still retains its draft when storage is unavailable. */
  }
}
