import { ChatMarkdown } from "@livingbot/chat-ui/web";
import { INLINE_VISUAL_REFERENCE_EVENT } from "@livingbot/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@livingbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type {
  SkillDocument,
  SkillSummary,
} from "../../../../../packages/kernel-runtime/src/skill-documents";
import { LoadingState } from "../../components/ai/primitives";
import { localAbilityRequest } from "../../lib/local-abilities";
import { localConnection } from "../../lib/local-workbench";

export async function skillRequest<T>(path: string, input?: unknown): Promise<T> {
  const connection = await localConnection();
  if (!connection) throw new Error("本机服务未连接");
  return localAbilityRequest(connection)<T>(
    path,
    input === undefined ? undefined : { method: "POST", body: JSON.stringify(input) },
  );
}
export function SkillDocumentView({
  identity,
  load,
  onModify,
}: {
  identity: string;
  load: (path: string) => Promise<SkillDocument | null>;
  onModify?: () => void;
}) {
  const [path, setPath] = useState("SKILL.md");
  const state = useQuery({
    queryKey: ["skill-document", identity, path],
    queryFn: () => load(path),
    retry: false,
  });
  return (
    <section className="space-y-4 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">技能文档</h3>
        {onModify && (
          <Button variant="outline" size="sm" onClick={onModify}>
            让 Bot 修改
          </Button>
        )}
      </div>
      {state.isPending ? (
        <LoadingState label="正在读取技能文档" />
      ) : state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {String(state.error)}
        </p>
      ) : state.data ? (
        <>
          <NativeSelect
            aria-label="技能文件"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          >
            {state.data.files.map((file) => (
              <NativeSelectOption key={file} value={file}>
                {file}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <div className="min-w-0 overflow-x-auto text-sm">
            {path.toLowerCase().endsWith(".md") ? (
              <>
                <ChatMarkdown>
                  {state.data.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}
                </ChatMarkdown>
                {state.data.content.startsWith("---\n") && (
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      文档元数据
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap text-xs">
                      {state.data.content.split("---")[1]}
                    </pre>
                  </details>
                )}
              </>
            ) : (
              <pre className="whitespace-pre-wrap break-words">{state.data.content}</pre>
            )}
          </div>
          {state.data.skill.source === "openclaw-workshop" && (
            <details>
              <summary className="cursor-pointer text-sm">变更记录</summary>
              {state.data.changes.length ? (
                state.data.changes.map((change, index) => (
                  <p key={index} className="mt-2 text-sm text-muted-foreground">
                    {change.at ? new Date(change.at).toLocaleString() : ""} {change.kind}{" "}
                    {change.reason}
                  </p>
                ))
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">暂无变更记录</p>
              )}
            </details>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">暂无文档</p>
      )}
    </section>
  );
}
export function ExclusiveSkills({ botId }: { botId: string }) {
  const state = useQuery({
    queryKey: ["exclusive-skills", botId],
    queryFn: () => skillRequest<SkillSummary[]>(`/api/bots/${encodeURIComponent(botId)}/skills`),
    retry: false,
  });
  const [selected, setSelected] = useState<string>();
  const skill = state.data?.find((item) => item.key === selected);
  return (
    <div className="space-y-5">
      {state.isPending && <LoadingState label="正在读取专属技能" />}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {String(state.error)}
        </p>
      )}
      {state.data &&
        ([false, true] as const).map((workshop) => (
          <section key={String(workshop)}>
            <h3 className="mb-2 text-sm font-medium">{workshop ? "系统沉淀" : "主动沉淀"}</h3>
            {state.data
              .filter((item) => (item.source === "openclaw-workshop") === workshop)
              .map((item) => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={selected === item.key}
                  onClick={() => setSelected(item.key)}
                  className="block w-full rounded-lg border border-border p-3 text-left hover:bg-muted aria-pressed:bg-muted"
                >
                  <span className="text-sm font-medium">{item.name}</span>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </button>
              ))}
            {!state.data.some((item) => (item.source === "openclaw-workshop") === workshop) && (
              <p className="text-sm text-muted-foreground">暂无技能</p>
            )}
          </section>
        ))}
      {skill && (
        <SkillDocumentView
          key={skill.key}
          identity={`${botId}:${skill.key}`}
          load={(path) =>
            skillRequest(
              `/api/bots/${encodeURIComponent(botId)}/skills/document?key=${encodeURIComponent(skill.key)}&path=${encodeURIComponent(path)}`,
            )
          }
          onModify={() =>
            window.dispatchEvent(
              new CustomEvent(INLINE_VISUAL_REFERENCE_EVENT, {
                detail: {
                  text: `请修改我的专属技能「${skill.name}」（${skill.source}，${skill.key}）。${skill.source === "openclaw-workshop" ? "请通过 Workshop 接口修改并保留版本历史。" : "请修改工作区 skills 中的对应技能。"}修改要求：`,
                },
              }),
            )
          }
        />
      )}
    </div>
  );
}
