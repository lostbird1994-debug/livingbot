import type { ConversationFindFilters, ConversationFindItem } from "@livingbot/contracts";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@livingbot/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ArtifactFileCard } from "../../components/ArtifactFileCard";
import { DeliveryFileCard } from "../../components/DeliveryFileCard";
import { HighlightedText } from "../../components/HighlightedText";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useSpaceQueries } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { useBotsSidebarWidth } from "./sidebar-layout";

type Rpc = ReturnType<typeof createSpaceRpc>;
type Mode = ConversationFindFilters["mode"];
type Filters = {
  query: string;
  sender: ConversationFindFilters["sender"];
  from: string;
  to: string;
  fileType: ConversationFindFilters["fileType"];
};
const initial: Filters = { query: "", sender: "all", from: "", to: "", fileType: "all" };
const typeNames = {
  all: "全部类型",
  document: "文档",
  spreadsheet: "表格",
  image: "图片",
  other: "其他",
};

export function ConversationFindPanel({
  rpc,
  target,
  open,
  onClose,
  onJump,
}: {
  rpc: Rpc;
  target: ArtifactTarget;
  open: boolean;
  onClose(): void;
  onJump(messageId: string): Promise<void>;
}) {
  const filterId = useId();
  const queries = useSpaceQueries();
  const sidebarWidth = useBotsSidebarWidth();
  const [mode, setMode] = useState<Mode>("messages");
  const [byMode, setByMode] = useState({ messages: { ...initial }, files: { ...initial } });
  const filters = byMode[mode];
  const update = (patch: Partial<Filters>) =>
    setByMode((value) => ({ ...value, [mode]: { ...value[mode], ...patch } }));
  const [expanded, setExpanded] = useState(false);
  const [debouncedQueries, setDebouncedQueries] = useState<Record<Mode, string>>({
    messages: "",
    files: "",
  });
  const query = debouncedQueries[mode];
  const debouncing = filters.query !== query;
  const [jumpError, setJumpError] = useState("");
  const [jumping, setJumping] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQueries((value) => ({ ...value, [mode]: filters.query })),
      200,
    );
    return () => clearTimeout(timer);
  }, [filters.query, mode]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const invalidDate = Boolean(filters.from && filters.to && filters.from > filters.to);
  const filtered =
    filters.sender !== "all" ||
    Boolean(filters.from || filters.to) ||
    (mode === "files" && filters.fileType !== "all");
  const ready = mode === "files" || Boolean(filters.query.trim() || filtered);
  const args = {
    ...target,
    mode,
    query,
    sender: filters.sender,
    fileType: filters.fileType,
    ...(filters.from ? { from: new Date(`${filters.from}T00:00:00`).toISOString() } : {}),
    ...(filters.to ? { to: new Date(`${filters.to}T23:59:59.999`).toISOString() } : {}),
  };
  const result = useInfiniteQuery({
    queryKey: queries.threads.find.queryKey({ input: args }),
    queryFn: ({ pageParam, signal }) =>
      rpc.threads.find(
        { ...args, ...(pageParam === undefined ? {} : { before: pageParam }) },
        { signal },
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    enabled: open && ready && !invalidDate && !debouncing,
    retry: false,
    staleTime: 15000,
  });
  const items = result.data?.pages.flatMap((page) => page.items) ?? [];
  async function jump(messageId: string) {
    setJumpError("");
    setJumping(messageId);
    try {
      await onJump(messageId);
      if (window.innerWidth - sidebarWidth < 640) onClose();
    } catch (e) {
      setJumpError(errorText(e));
    } finally {
      setJumping(null);
    }
  }
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label="查找此对话"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (expanded) setExpanded(false);
          else onClose();
        }
      }}
    >
      <div className="shrink-0 space-y-4 border-b border-border/60 px-5 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <SectionHeading>查找此对话</SectionHeading>
          <Button variant="ghost" size="icon-sm" aria-label="关闭查找" onClick={onClose}>
            <X />
          </Button>
        </div>
        <Tabs
          value={mode}
          onValueChange={(value) => {
            setMode(value as Mode);
            setJumpError("");
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="messages" className="flex-1">
              聊天记录
            </TabsTrigger>
            <TabsTrigger value="files" className="flex-1">
              聊天文件
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={input}
              aria-label={mode === "messages" ? "搜索聊天记录" : "搜索聊天文件"}
              placeholder={mode === "messages" ? "搜索关键词…" : "搜索文件名…"}
              value={filters.query}
              onChange={(e) => update({ query: e.target.value })}
              className="ps-9 pe-8"
            />
            {filters.query ? (
              <button
                type="button"
                aria-label="清空关键词"
                className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                onClick={() => update({ query: "" })}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button
            variant={expanded || filtered ? "secondary" : "ghost"}
            size="icon"
            aria-label="筛选"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <SlidersHorizontal className="size-4" />
          </Button>
        </div>
        {filtered ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              {[
                filters.sender === "user"
                  ? "我发送的"
                  : filters.sender === "bot"
                    ? "Bot 发送的"
                    : "",
                filters.from || filters.to
                  ? `${filters.from || "最早"} 至 ${filters.to || "今天"}`
                  : "",
                mode === "files" && filters.fileType !== "all" ? typeNames[filters.fileType] : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => update({ ...initial, query: filters.query })}
            >
              清除筛选
            </button>
          </div>
        ) : null}
        {invalidDate ? (
          <p role="alert" className="text-xs text-destructive">
            结束日期不能早于开始日期。
          </p>
        ) : null}
      </div>
      <div
        className="rk-scroll min-h-0 flex-1 overflow-y-auto px-5 py-3"
        aria-busy={result.isFetching || debouncing}
      >
        {expanded ? (
          <div className="mb-4 space-y-3 rounded-xl bg-muted/50 p-3">
            <label
              htmlFor={`${filterId}-sender`}
              className="block space-y-1.5 text-xs text-muted-foreground"
            >
              <span>发送人</span>
              <NativeSelect
                id={`${filterId}-sender`}
                aria-label="发送人"
                value={filters.sender}
                onChange={(e) => update({ sender: e.target.value as Filters["sender"] })}
              >
                <NativeSelectOption value="all">全部发送人</NativeSelectOption>
                <NativeSelectOption value="user">我发送的</NativeSelectOption>
                <NativeSelectOption value="bot">Bot 发送的</NativeSelectOption>
              </NativeSelect>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label
                htmlFor={`${filterId}-from`}
                className="min-w-0 space-y-1.5 text-xs text-muted-foreground"
              >
                <span>开始日期</span>
                <Input
                  type="date"
                  id={`${filterId}-from`}
                  aria-label="开始日期"
                  value={filters.from}
                  onChange={(e) => update({ from: e.target.value })}
                  className="min-w-0 text-xs"
                />
              </label>
              <label
                htmlFor={`${filterId}-to`}
                className="min-w-0 space-y-1.5 text-xs text-muted-foreground"
              >
                <span>结束日期</span>
                <Input
                  type="date"
                  id={`${filterId}-to`}
                  aria-label="结束日期"
                  value={filters.to}
                  onChange={(e) => update({ to: e.target.value })}
                  className="min-w-0 text-xs"
                />
              </label>
            </div>
            {mode === "files" ? (
              <label
                htmlFor={`${filterId}-type`}
                className="block space-y-1.5 text-xs text-muted-foreground"
              >
                <span>文件类型</span>
                <NativeSelect
                  id={`${filterId}-type`}
                  aria-label="文件类型"
                  value={filters.fileType}
                  onChange={(e) => update({ fileType: e.target.value as Filters["fileType"] })}
                >
                  {Object.entries(typeNames).map(([value, label]) => (
                    <NativeSelectOption key={value} value={value}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
          </div>
        ) : null}
        {jumpError ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {jumpError}
          </p>
        ) : null}
        {!ready ? <Empty text="输入关键词，查找曾经聊过的内容" /> : null}
        {ready && !invalidDate && (result.isPending || debouncing) ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner />
            正在查找…
          </div>
        ) : null}
        {ready && !invalidDate && !debouncing && result.isError ? (
          <div role="alert" className="space-y-3 py-6 text-sm">
            <p>查找失败，已有结果已保留。</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (result.isFetchNextPageError) void result.fetchNextPage();
                else void result.refetch();
              }}
            >
              重试
            </Button>
          </div>
        ) : null}
        {ready &&
        !invalidDate &&
        !debouncing &&
        !result.isPending &&
        !result.isError &&
        !items.length ? (
          <Empty
            text={
              result.hasNextPage
                ? "暂未找到匹配，可以继续查找较早记录"
                : mode === "files" && !query && !filtered
                  ? "此对话还没有收发过文件"
                  : "没有找到匹配的记录"
            }
          />
        ) : null}
        <div className="divide-y divide-border/60">
          {!invalidDate && ready && !debouncing
            ? items.map((item) => (
                <div key={item.id} className="py-3">
                  <div className="mb-2 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{item.senderName}</span>
                    <time className="shrink-0" dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString("zh-CN", {
                        year: "numeric",
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  {item.kind === "message" ? (
                    <button
                      type="button"
                      disabled={jumping === item.messageId}
                      onClick={() => void jump(item.messageId)}
                      className="w-full rounded-lg text-left text-sm leading-6 hover:bg-muted/60 focus-visible:outline focus-visible:outline-ring"
                      aria-label={`查看原消息：${item.snippet.slice(0, 32)}`}
                    >
                      <span className="line-clamp-4 break-words">
                        <HighlightedText text={item.snippet} query={query} />
                      </span>
                      <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        {jumping === item.messageId ? "正在定位…" : "查看原消息"}
                        <ArrowUpRight className="size-3" />
                      </span>
                    </button>
                  ) : (
                    <>
                      <HistoryFile item={item} rpc={rpc} target={target} query={query} />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-7 px-0 text-xs text-muted-foreground"
                        disabled={jumping === item.messageId}
                        onClick={() => void jump(item.messageId)}
                      >
                        {jumping === item.messageId ? "正在定位…" : "查看原消息"}
                        <ArrowUpRight className="size-3" />
                      </Button>
                    </>
                  )}
                </div>
              ))
            : null}
        </div>
        {ready && !invalidDate && !debouncing && result.hasNextPage ? (
          <Button
            variant="outline"
            className="my-3 w-full"
            disabled={result.isFetching}
            onClick={() => void result.fetchNextPage()}
          >
            {result.isFetchingNextPage ? "正在查找…" : "继续查找较早记录"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="py-10 text-center text-sm leading-6 text-muted-foreground">{text}</p>;
}
function HistoryFile({
  item,
  rpc,
  target,
  query,
}: {
  query: string;
  item: Extract<ConversationFindItem, { kind: "file" }>;
  rpc: Rpc;
  target: ArtifactTarget;
}) {
  const queries = useSpaceQueries();
  const info = useQuery({
    queryKey: item.artifactId
      ? queries.artifacts.fileInfo.queryKey({ input: { artifactId: item.artifactId } })
      : queries.threads.fileInfo.queryKey({
          input: { ...target, messageId: item.messageId, path: item.path! },
        }),
    queryFn: async () =>
      item.artifactId
        ? rpc.artifacts.fileInfo({ artifactId: item.artifactId })
        : rpc.threads.fileInfo({ ...target, messageId: item.messageId, path: item.path! }),
    retry: false,
    staleTime: 15000,
  });
  if (item.artifactId)
    return (
      <>
        <ArtifactFileCard
          compact
          preferPreview
          wrapName
          nameHighlight={query}
          sourceAvailable={Boolean(info.data && "sourcePath" in info.data && info.data.sourcePath)}
          target={target}
          artifactId={item.artifactId}
          name={item.name}
          mimeType={item.mimeType}
          size={item.size ?? (info.data && "size" in info.data ? info.data.size : undefined)}
        />
        {info.isError ? (
          <p className="mt-1 text-xs text-destructive">附件不可用，仍可查看原消息。</p>
        ) : null}
      </>
    );
  const local = info.data && "path" in info.data ? info.data : undefined;
  return (
    <DeliveryFileCard
      name={item.name}
      wrapName
      nameHighlight={query}
      size={local?.size}
      disabled={!local}
      status={info.isPending ? "正在定位文件…" : "源文件不可用"}
      error={info.isError ? "源文件已失效，仍可查看原消息。" : undefined}
      onOpen={async () => {
        await rpc.threads.fileAction({
          ...target,
          messageId: item.messageId,
          path: item.path!,
          action: "open",
        });
      }}
      onReveal={
        local
          ? async () => {
              await rpc.threads.fileAction({
                ...target,
                messageId: item.messageId,
                path: item.path!,
                action: "reveal",
              });
            }
          : undefined
      }
      onCopy={local ? async () => navigator.clipboard.writeText(local.path) : undefined}
    />
  );
}
