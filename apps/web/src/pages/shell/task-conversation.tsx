import type { Bot, ConversationUsage, LoginFieldInput, ModelCatalogEntry, TaskSession, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { answerableAskMessageIds, chatUserBubbleColors, dismissableAskMessageIds, foldPeerReplies, newClientId } from "@rakazo/core";
import { toast, Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { clearConnectorScope, readConnectorScope, scopeKeyForTarget } from "../../lib/connector-scope";
import { writeComposerDraft } from "../../lib/composer-draft";
import { readFileAsBase64 } from "../../lib/pending-attachments";
import type { RpcClient } from "../../lib/rpc";
import type { TaskDraftFile } from "../../lib/task-draft-files";
import { readTaskDraftFiles, writeTaskDraftFiles } from "../../lib/task-draft-files";
import { prependThreadMessagePage, reduceThreadSnapshot } from "../../lib/thread-events";
import { errorText } from "../../lib/user-error";
import { Composer } from "./composer";
import { ConversationFindPanel } from "./conversation-find-panel";
import { ComposerUsage } from "./composer-usage";
import { Transcript } from "./transcript";

interface DraftSelection { provider: string; modelId: string; thinkingLevel: string | null }
export function TaskConversation({ bot, tabKey, session, rpc, scope, userId, enterToSend, onStarted, onChanged, onOpenBot, onOpenComputer, findRequest }:  {
  bot: Bot; tabKey: string; session?: TaskSession; rpc: RpcClient; scope: string; userId: string;
  enterToSend: boolean; findRequest: number; onStarted: (draftKey: string, session: TaskSession) => void;
  onChanged: () => Promise<void>; onOpenBot: (id: string) => void; onOpenComputer: () => void;
}) {
  const isDraft = tabKey.startsWith("draft:");
  const draftKey = `task:${scope}:${bot.id}:${tabKey}`;
  const artifactTarget: ArtifactTarget = { botId: bot.id, taskSessionId: isDraft ? undefined : tabKey, draftScope: isDraft ? tabKey : undefined };
  const target = { botId: bot.id, taskSessionId: tabKey };
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<TaskDraftFile[]>([]);
  const filesRef = useRef<TaskDraftFile[]>([]);
  const fileWrite = useRef(Promise.resolve());
  const [filesReady, setFilesReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sent, setSent] = useState(0);
  const [reply, setReply] = useState<{ message: ThreadMessage; quote?: string } | null>(null);
  const [usage, setUsage] = useState<ConversationUsage>();
  const [modelOpen, setModelOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => { if (findRequest && !isDraft) setFindOpen(true); }, [findRequest]);
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [selection, setSelection] = useState<DraftSelection | null>(() => {
    try { return JSON.parse(localStorage.getItem(`${draftKey}:model`) ?? "null"); } catch { return null; }
  });
  const [scrollRequest, setScrollRequest] = useState<{ messageId: string; nonce: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function commit(value: ThreadSnapshot) { snapshotRef.current = value; if (mounted.current) setSnapshot(value); }
  async function refresh() {
    if (isDraft) return;
    const value = await rpc.threads.get(target);
    commit(value);
    return value;
  }
  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    if (isDraft) return;
    async function follow() {
      try {
        const value = await rpc.threads.get(target, { signal: controller.signal });
        commit(value);
        await rpc.threads.markRead(target, { signal: controller.signal });
        const events = await rpc.threads.subscribe({ ...target, cursor: value.cursor }, { signal: controller.signal });
        for await (const event of events) {
          if (controller.signal.aborted) return;
          const next = reduceThreadSnapshot(snapshotRef.current, event);
          if (next) commit(next);
          if (event.type === "thread.message.created" && document.visibilityState === "visible") void rpc.threads.markRead(target).catch(() => {});
          if (event.type.startsWith("run.") || event.type === "thread.message.created") void onChanged();
        }
      } catch (caught) {
        if (!controller.signal.aborted && mounted.current) setError(errorText(caught));
      }
      if (!controller.signal.aborted) retryTimer = setTimeout(() => void follow(), 1500);
    }
    void follow();
    return () => { controller.abort(); if (retryTimer) clearTimeout(retryTimer); };
  }, [tabKey, bot.id, rpc]);
  useEffect(() => {
    if (!isDraft) void rpc.usage.thread(target).then(setUsage).catch(() => {});
  }, [tabKey, session?.status, snapshot?.run?.id]);
  useEffect(() => {
    let alive = true;
    void readTaskDraftFiles(draftKey).then(rows => {
      if (alive) { filesRef.current = rows; setFiles(rows); setFilesReady(true); }
    }).catch(() => { if (alive) { setError("附件草稿无法读取，请重试"); } });
    return () => { alive = false; };
  }, [draftKey]);
  function saveFiles(rows: TaskDraftFile[]) {
    filesRef.current = rows;
    if (mounted.current) setFiles(rows);
    fileWrite.current = fileWrite.current.catch(() => {}).then(() => writeTaskDraftFiles(draftKey, rows));
    void fileWrite.current.catch(() => { if (mounted.current) setError("附件草稿未能保存，请保留此页后重试"); });
    return fileWrite.current;
  }
  const pending = useMemo(() => files.map(file => ({ id: file.id, threadKey: draftKey,
    file: file.file ?? new File([], file.name, { type: file.type }) })), [files, draftKey]);
  const running = Boolean(snapshot?.activeRuns?.length || session && (!["completed", "failed", "cancelled"].includes(session.status) || ["unconfirmed", "stopping"].includes(session.resourceWaitReason ?? "")));
  const canContinue = session?.resourceWaitReason !== "unconfirmed" && session?.resourceWaitReason !== "stopping";
  async function send(text: string, _mentions: unknown, clientNonce: string, imageHandling?: "file") {
    if (!filesReady || sending || !canContinue) return false;
    setSending(true); setError(null);
    try {
      await fileWrite.current;
      const artifactIds: string[] = [];
      for (const entry of filesRef.current) {
        let id = entry.artifactId;
        if (!id) {
          if (!entry.file) throw new Error("附件内容不可用，请重新选择");
          const created = await rpc.artifacts.create({ botId: bot.id, name: entry.name, mimeType: entry.type || "application/octet-stream",
            contentBase64: await readFileAsBase64(entry.file), clientNonce: `task-file:${entry.id}` });
          id = created.id;
          await saveFiles(filesRef.current.map(row => row.id === entry.id ? { ...row, artifactId: id, file: undefined } : row));
        }
        artifactIds.push(id);
      }
      const input = { botId: bot.id, text, artifactIds, clientNonce,
        connectorScope: readConnectorScope(scopeKeyForTarget(artifactTarget)), imageHandling,
        ...(selection ? { modelProvider: selection.provider, modelId: selection.modelId, thinkingLevel: selection.thinkingLevel } : {}) };
      if (isDraft) {
        const accepted = await rpc.taskSessions.start({ ...input, clientNonce: tabKey });
        if (!accepted.requestMatched) {
          const acceptedKey = `task:${scope}:${bot.id}:${accepted.session.id}`;
          writeComposerDraft(acceptedKey, text);
          await writeTaskDraftFiles(acceptedKey, filesRef.current);
          toast.info("上次任务已接收，修改后的要求已保留为该任务的草稿");
        }
        await saveFiles([]);
        onStarted(tabKey, accepted.session);
      } else {
        await rpc.threads.send({ ...input, taskSessionId: tabKey, replyToMessageId: reply?.message.id, replyQuote: reply?.quote });
        await saveFiles([]); setReply(null);
        await refresh();
      }
      if (mounted.current) setSent(value => value + 1);
      clearConnectorScope(scopeKeyForTarget(artifactTarget));
      void onChanged();
      return true;
    } catch (caught) { if (mounted.current) setError(errorText(caught)); return false; }
    finally { if (mounted.current) setSending(false); }
  }
  async function answer(message: ThreadMessage, text: string, fields?: LoginFieldInput[], dismiss?: boolean, remember?: false) {
    if (!message.runId) throw new Error("任务运行不可用");
    await rpc.threads.answer({ ...target, runId: message.runId, messageId: message.id, answer: text, ...(fields ? { fields } : {}), ...(dismiss ? { dismiss: true as const } : { clientNonce: newClientId() }), ...(remember === false ? { remember } : {}) });
    await refresh(); await onChanged();
  }
  async function stop() {
    if (isDraft) return;
    setError(null);
    try { await rpc.threads.stop(target); await refresh(); await onChanged(); }
    catch (caught) { setError(errorText(caught)); }
  }
  const title = session?.title ?? "新任务";
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="task-conversation">
    <div className="flex items-center justify-between gap-2 px-5 py-2 text-sm text-muted-foreground">
      {isDraft ? <span role="status">未发送</span> : null}
      <Button size="sm" variant="ghost" aria-label="选择此任务的模型" onClick={() => {
        setModelOpen(true); void rpc.models.list().then(setModels).catch(caught => setError(errorText(caught)));
      }}>{selection?.modelId ?? session?.modelId ?? "选择模型"}</Button>
      {!isDraft && session ? <Button size="sm" variant="ghost" onClick={async () => {
        const next = window.prompt("任务名称", session.title)?.trim();
        if (next) { try { await rpc.taskSessions.rename({ ...target, title: next }); await onChanged(); } catch (caught) { setError(errorText(caught)); } }
      }}>重命名</Button> : null}
    </div>
    {isDraft ? <div className="flex-1 px-6 pt-12 text-center text-sm text-muted-foreground">描述一项独立委托</div> : snapshot ? <Transcript
      scrollRef={scroll} scrollRequest={scrollRequest} onScrollRequestHandled={() => setScrollRequest(null)} followRequest={sent}
      artifactTarget={artifactTarget} transcript={foldPeerReplies(snapshot.messages, { includePeerReceipts: true })}
      showToolActivity olderCursor={snapshot.olderCursor} unreadAfterSeq={null} loadingOlder={loadingOlder}
      answerableAskIds={answerableAskMessageIds(snapshot)} dismissableAskIds={dismissableAskMessageIds(snapshot, userId)}
      running={running} workingBots={running ? [{ botId: bot.id, name: bot.name, color: bot.color, avatarSet: bot.avatarSet }] : []}
      userBubble={chatUserBubbleColors(bot.color, bot.id)}
      onLoadOlder={async () => { if (snapshot.olderCursor === null) return; setLoadingOlder(true); try {
        const page = await rpc.threads.messages({ ...target, before: snapshot.olderCursor });
        const next = prependThreadMessagePage(snapshotRef.current, page); if (next) commit(next);
      } finally { setLoadingOlder(false); } }}
      onOpenBot={onOpenBot} onAnswer={answer} onReply={message => setReply({ message })} onQuote={(message, quote) => setReply({ message, quote })}
      onMarkUnread={async message => { await rpc.threads.markUnread({ ...target, messageId: message.id }); await onChanged(); }}
      onReact={async (message, reaction) => { await rpc.threads.react({ ...target, messageId: message.id, reaction, clientNonce: newClientId() }); await refresh(); }}
      onJumpToMessage={messageId => setScrollRequest({ messageId, nonce: Date.now() })}
      onOpenPeerMessages={() => setError("请在主聊天查看 Bot 间消息")}
      peerBot={id => id === bot.id ? bot : undefined} onRefresh={async () => { await refresh(); }} onBotChanged={onChanged}
      onAddRoutine={() => setError("请在主聊天的任务清单中添加例行任务")} voiceReady={false} speakingMessageId={null} onSpeak={() => {}}
      onOpenComputer={onOpenComputer}
    /> : <div className="grid flex-1 place-items-center text-sm text-muted-foreground">正在读取任务…</div>}
    <div className="relative z-20 -mt-7">
      <Composer draftKey={draftKey} artifactTarget={artifactTarget} activeName={title} targetLabel={`给「${title}」补充要求`} enterToSend={enterToSend}
        running={running} disabled={!filesReady || !canContinue || sending} pendingAttachments={pending} attachmentNotice={null}
        sendError={error} runError={session?.status === "failed" ? snapshot?.run?.error ?? null : null} runErrorId={snapshot?.run?.id ?? null}
        onRunErrorPresented={() => {}} onDismissError={() => setError(null)} sending={sending} fileInputRef={fileInput}
        onAttachmentPick={picked => { if (!picked || !filesReady) return false;
          void saveFiles([...filesRef.current, ...Array.from(picked).map(file => ({ id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, file }))]); return true; }}
        onRemoveAttachment={entry => { void saveFiles(filesRef.current.filter(row => row.id !== entry.id)); }} onSend={send} onStop={stop}
        onOpenModels={() => { setModelOpen(true); void rpc.models.list().then(setModels).catch(caught => setError(errorText(caught))); }}
        onOpenConnections={() => setError("在连接器按钮中选择此任务可以使用的连接器")}
        replyTarget={reply?.message} replyQuote={reply?.quote} replyTargetName={bot.name} onClearReply={() => setReply(null)}
      />
      <ComposerUsage usage={usage} />
    </div>
    <Dialog open={findOpen} onOpenChange={setFindOpen}><DialogContent className="h-[min(80dvh,48rem)] p-0 sm:max-w-xl">
      <DialogHeader className="sr-only"><DialogTitle>查找任务内容与文件</DialogTitle></DialogHeader>
      <ConversationFindPanel rpc={rpc} target={artifactTarget} open={findOpen} onClose={() => setFindOpen(false)} onJump={async messageId => {
        const page = await rpc.threads.messages({ ...target, around: { messageId } });
        if (snapshotRef.current) commit({ ...snapshotRef.current, messages: page.messages, olderCursor: page.olderCursor });
        setScrollRequest({ messageId, nonce: Date.now() }); setFindOpen(false);
      }} />
    </DialogContent></Dialog>
    <Dialog open={modelOpen} onOpenChange={setModelOpen}><DialogContent><DialogHeader><DialogTitle>此任务的模型</DialogTitle></DialogHeader>
      {running ? <p className="text-sm text-muted-foreground">当前执行使用已保存的模型；更改将在下一轮生效。</p> : null}
      <div className="max-h-80 overflow-y-auto">{models.map(model => <Button key={`${model.provider}/${model.id}`} variant="ghost" className="w-full justify-start" onClick={() => {
        const choice = { provider: model.provider, modelId: model.id, thinkingLevel: null };
        setSelection(choice); localStorage.setItem(`${draftKey}:model`, JSON.stringify(choice)); setModelOpen(false);
      }}>{model.label}</Button>)}</div>
    </DialogContent></Dialog>
  </div>;
}
