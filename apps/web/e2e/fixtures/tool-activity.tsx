import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage } from "@livingbot/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { queryClient } from "../../src/lib/query";
import {
  getToolActivityEnabled,
  subscribeToolActivity,
} from "../../src/lib/tool-activity-preference";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import "../../src/styles.css";
import { FixtureTranscript } from "./thread-fixture";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "settings" ? "settings" : "thread";
const live = params.get("phase") === "live";
const withReasoning = params.get("reasoning") === "true";
const THOUGHT = "I will check the calendar before choosing a time.";
const longReasoning = Array.from(
  { length: 12 },
  (_, i) =>
    `${i + 1}. ${THOUGHT} Compare the available times with the source and keep the recommendation clear.`,
).join("\n\n");

const USER_TEXT = "Find a free slot on Tuesday.";
const REPLY_TEXT = "Tuesday at 2 pm is free.";
const STEPS = [
  { label: "Read file", tool: "read_file", detail: "memory-organization.ts" },
  { label: "Read file", tool: "read_file", detail: "builtin-routines.ts" },
  { label: "Search memory", tool: "search_memory", detail: "memory organization prompt" },
  { label: "Exec", tool: "exec", detail: "git diff --stat" },
  { label: "Web search", tool: "web_search", detail: "open calendar slots" },
  { label: "Write file", tool: "write_file", detail: "notes/tuesday.md" },
  { label: "Read file", tool: "read_file", detail: "memory-organization.ts" },
  { label: "Memory search", tool: "memory_search", detail: "invoice" },
];

const NOTE_TEXT = "Anna is free all Tuesday afternoon.";

const stepsBlock: MessageBlock = {
  kind: "steps",
  steps: STEPS.map((step) => ({
    ...step,
    count: 1,
    // A finished reply keeps what the bot wrote before a step on that step.
    ...(!live && step.detail === "invoice" ? { note: NOTE_TEXT } : {}),
  })),
  ...(live ? {} : { durationMs: 88_000 }),
};

const createdAt = "2026-08-16T00:00:01.000Z";
const processBlocks: MessageBlock[] = withReasoning
  ? [
      { kind: "reasoning", text: longReasoning },
      { kind: "text", text: "I will inspect the sources before choosing a time." },
      { kind: "steps", steps: stepsBlock.steps.slice(0, 4) },
      { kind: "reasoning", text: "The sources agree. I can now save the recommendation." },
      { kind: "progress", text: "The sources confirm Tuesday afternoon is available." },
      { kind: "steps", steps: stepsBlock.steps.slice(4), durationMs: live ? undefined : 88_000 },
      ...(live ? [{ kind: "reasoning" as const, text: longReasoning }] : []),
    ]
  : [stepsBlock];

// A live run that has only called tools so far, or the finished reply with its tool card.
const messages: ThreadMessage[] = [
  {
    id: "user-1",
    threadId: "thread-1",
    seq: 1,
    role: "user",
    blocks: [{ kind: "text", text: USER_TEXT }],
    createdAt,
  },
  {
    id: live ? "progress:run-1" : "bot-reply",
    threadId: "thread-1",
    seq: 2,
    role: "bot",
    blocks: live ? processBlocks : [...processBlocks, { kind: "text", text: REPLY_TEXT }],
    botId: "bot-1",
    runId: "run-1",
    createdAt,
  },
];

function ThreadFixture() {
  const showToolActivity = useSyncExternalStore(subscribeToolActivity, getToolActivityEnabled);
  return (
    <FixtureTranscript messages={messages} running={live} showToolActivity={showToolActivity} />
  );
}

function SettingsFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SettingsOverlay
        email="owner@example.test"
        name="Owner"
        memoryConfig={null}
        onMemoryConfigChange={() => {}}
        onClose={() => {}}
        section="general"
        onSectionChange={() => {}}
      />
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        {view === "settings" ? <SettingsFixture /> : <ThreadFixture />}
      </I18nProvider>
    </QueryClientProvider>,
  );
});
