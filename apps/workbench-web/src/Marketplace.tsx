import { useEffect, useRef, useState } from "react";
import { Download, PackageOpen } from "lucide-react";
import { Button } from "@livingbot/ui-web/components/ui/button";
import { Input } from "@livingbot/ui-web/components/ui/input";
import { Textarea } from "@livingbot/ui-web/components/ui/textarea";
import { SectionHeading } from "../../../packages/ui-web/src/section-heading.tsx";
import type { CatalogSubmission, MarketCatalog, PackageInstallation, PackagePreview, PackageShare, PackageUpdate, ShareableMethod } from "../../../packages/workbench/src/marketplace.ts";
import type { WorkbenchClient } from "./client.ts";

function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Marketplace({ client, botId, onInstalled }: {
  client: WorkbenchClient; botId: string; onInstalled(): void;
}) {
  const [repository, setRepository] = useState("");
  const [path, setPath] = useState("livingbot.json");
  const [ref, setRef] = useState("");
  const [preview, setPreview] = useState<PackagePreview>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [installed, setInstalled] = useState<PackageInstallation[]>([]);
  const [updates, setUpdates] = useState<PackageUpdate[]>([]);
  const [updateFor, setUpdateFor] = useState("");
  const [replaceIdentity, setReplaceIdentity] = useState(false);
  const [catalogs, setCatalogs] = useState<MarketCatalog[]>([]);
  const [catalog, setCatalog] = useState<MarketCatalog>();
  const [catalogPath, setCatalogPath] = useState("livingbot-market.json");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [submission, setSubmission] = useState<CatalogSubmission>();
  const [submissions, setSubmissions] = useState<CatalogSubmission[]>([]);
  const [tags, setTags] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setPreview(undefined); setReviewed(false); setError(undefined); setBusy(false);
    setUpdateFor(""); setReplaceIdentity(false); setUpdates([]); setSubmission(undefined);
    void Promise.all([
      client.request<PackageInstallation[]>("/api/marketplace/installations"),
      client.request<PackageUpdate[]>("/api/marketplace/updates"),
      client.request<MarketCatalog[]>("/api/marketplace/catalogs"),
      client.request<CatalogSubmission[]>("/api/marketplace/submissions").catch(() => [] as CatalogSubmission[]),
    ])
      .then(([items, changes, directories, prepared]) => {
        if (generation.current === current) {
          setInstalled(items); setUpdates(changes); setCatalogs(directories); setSubmissions(prepared);
          setCatalog((previous) => previous ?? directories[0]);
        }
      })
      .catch((cause) => { if (generation.current === current) setError(String(cause)); });
    return () => { ++generation.current; };
  }, [client, botId]);

  function acceptPreview(result: PackagePreview) {
    setPreview(result); setReviewed(false); setReplaceIdentity(false); setSubmission(undefined);
    const matches = installed.filter((item) => item.state === "ready" && item.packageId === result.package.id &&
      item.source.repository === result.source.repository && item.source.path === result.source.path &&
      item.kind === result.package.kind && item.digest !== result.digest &&
      (item.kind === "bot" || item.botId === botId));
    setUpdateFor(matches.length === 1 ? matches[0]!.id : "");
  }
  async function browseCatalog() {
    const current = ++generation.current;
    setBusy(true); setError(undefined); setPreview(undefined); setReviewed(false); setSubmission(undefined);
    try {
      const result = await client.request<MarketCatalog>("/api/marketplace/catalog/preview", {
        repository: repository.trim(), path: catalogPath.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}),
      });
      if (generation.current !== current) return;
      setCatalog(result); setCatalogSearch("");
      setCatalogs((items) => [result, ...items.filter((item) =>
        item.source.repository !== result.source.repository || item.source.path !== result.source.path)]);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function inspectEntry(entryId: string) {
    if (!catalog) return;
    const current = ++generation.current;
    setBusy(true); setError(undefined); setPreview(undefined); setReviewed(false); setSubmission(undefined);
    try {
      const result = await client.request<PackagePreview>("/api/marketplace/catalog/entry", { catalogId: catalog.id, entryId });
      if (generation.current === current) acceptPreview(result);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function prepareSubmission() {
    if (!catalog || !preview || !reviewed) return;
    const current = generation.current;
    setBusy(true); setError(undefined); setSubmission(undefined);
    try {
      const result = await client.request<CatalogSubmission>("/api/marketplace/catalog/submission", {
        catalogId: catalog.id, previewId: preview.id, digest: preview.digest,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      if (generation.current === current) {
        setSubmission(result);
        setSubmissions((items) => [result, ...items.filter((item) => item.id !== result.id)]);
        setTags("");
      }
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function inspect() {
    const current = ++generation.current;
    setBusy(true); setError(undefined); setPreview(undefined); setReviewed(false);
    try {
      const result = await client.request<PackagePreview>("/api/marketplace/preview", {
        repository: repository.trim(), path: path.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}),
      });
      if (generation.current === current) acceptPreview(result);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function install() {
    if (!preview || !reviewed) return;
    const current = generation.current;
    setBusy(true); setError(undefined);
    try {
      const target = installed.find((item) => item.id === updateFor);
      const item = await client.request<PackageInstallation>(target ? "/api/marketplace/update" : "/api/marketplace/install", {
        previewId: preview.id, digest: preview.digest,
        ...(target ? { id: target.id, expectedDigest: target.digest, replaceIdentity } :
          preview.package.kind === "ability" ? { botId } : {}),
      });
      if (generation.current !== current) return;
      setInstalled((items) => [...items.filter((entry) => entry.id !== item.id), item]);
      setPreview(undefined); setReviewed(false);
      setUpdates((items) => items.filter((entry) => entry.installationId !== item.id)); onInstalled();
    } catch (cause) {
      if (generation.current === current) {
        setError(String(cause));
        const [items, changes] = await Promise.allSettled([
          client.request<PackageInstallation[]>("/api/marketplace/installations"),
          client.request<PackageUpdate[]>("/api/marketplace/updates"),
        ]);
        if (generation.current === current) {
          if (items.status === "fulfilled") setInstalled(items.value);
          if (changes.status === "fulfilled") setUpdates(changes.value);
        }
      }
    }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function resumeUpdate(item: PackageUpdate) {
    const current = ++generation.current;
    setBusy(true); setError(undefined); setReviewed(false); setSubmission(undefined);
    try {
      const result = await client.request<PackagePreview>(`/api/marketplace/previews/${item.previewId}`);
      if (generation.current !== current) return;
      setPreview(result); setUpdateFor(item.installationId); setReplaceIdentity(item.replaceIdentity);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function resumeInstallation(item: PackageInstallation) {
    const current = ++generation.current;
    setBusy(true); setError(undefined); setPreview(undefined); setReviewed(false); setSubmission(undefined);
    try {
      const result = await client.request<PackagePreview>(`/api/marketplace/previews/${item.previewId}`);
      if (generation.current !== current) return;
      setPreview(result); setUpdateFor(""); setReplaceIdentity(false);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function changeAccess(item: PackageInstallation, enabled: boolean) {
    const current = generation.current;
    setBusy(true); setError(undefined);
    try {
      const changed = await client.request<PackageInstallation>("/api/marketplace/access", { id: item.id, enabled });
      if (generation.current !== current) return;
      setInstalled((items) => items.map((entry) => entry.id === changed.id ? changed : entry));
      onInstalled();
    } catch (cause) {
      if (generation.current === current) {
        setError(String(cause));
        try {
          const items = await client.request<PackageInstallation[]>("/api/marketplace/installations");
          if (generation.current === current) setInstalled(items);
        } catch { /* The request error remains visible; no unconfirmed state is shown as success. */ }
      }
    } finally { if (generation.current === current) setBusy(false); }
  }

  return <details className="marketplace">
    <summary><PackageOpen size={16} />伙伴与能力市场</summary>
    <form className="marketplace-form" onSubmit={(event) => { event.preventDefault(); void inspect(); }}>
      <label>GitHub 仓库<Input aria-label="GitHub 仓库" placeholder="作者/仓库" value={repository}
        disabled={busy} onChange={(event) => { setRepository(event.target.value); setPreview(undefined); }} /></label>
      <details><summary>版本与文件</summary>
        <label>版本<Input aria-label="仓库版本" placeholder="默认版本" value={ref} disabled={busy}
          onChange={(event) => { setRef(event.target.value); setPreview(undefined); }} /></label>
        <label>包文件<Input aria-label="包文件" value={path} disabled={busy}
          onChange={(event) => { setPath(event.target.value); setPreview(undefined); }} /></label>
        <label>目录文件<Input aria-label="市场目录文件" value={catalogPath} disabled={busy}
          onChange={(event) => setCatalogPath(event.target.value)} /></label>
      </details>
      <div className="marketplace-actions">
        <Button variant="outline" disabled={busy || !repository.trim()} type="submit">{busy ? "处理中…" : "查看内容"}</Button>
        <Button variant="ghost" disabled={busy || !repository.trim()} onClick={() => void browseCatalog()}>浏览市场目录</Button>
      </div>
    </form>
    {catalogs.length > 1 && <label className="marketplace-target">市场目录
      <select aria-label="市场目录" value={catalog?.id ?? ""} disabled={busy}
        onChange={(event) => { setCatalog(catalogs.find((item) => item.id === event.target.value)); setCatalogSearch(""); setSubmission(undefined); }}>
        {catalogs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>}
    {catalog && <section className="marketplace-catalog">
      <SectionHeading>{catalog.name}</SectionHeading>
      <p className="marketplace-source">{catalog.source.repository} · {catalog.source.commit.slice(0,12)}</p>
      <Input aria-label="查找市场伙伴与能力" placeholder="查找伙伴与能力…" value={catalogSearch}
        onChange={(event) => setCatalogSearch(event.target.value)} />
      {catalog.entries.filter((item) => `${item.name} ${item.description} ${item.tags.join(" ")}`.toLocaleLowerCase()
        .includes(catalogSearch.trim().toLocaleLowerCase())).map((item) =>
        <article className="marketplace-catalog-entry" key={item.id}>
          <div><SectionHeading>{item.name}</SectionHeading><p>{item.description}</p>
            <small>{item.kind === "bot" ? "伙伴" : "能力"}{item.tags.length ? ` · ${item.tags.join(" · ")}` : ""}</small></div>
          <Button variant="outline" disabled={busy} aria-label={`查看 ${item.name}`}
            onClick={() => void inspectEntry(item.id)}>查看</Button>
        </article>)}
      {catalog.entries.length === 0 && <p className="marketplace-source">这个目录还没有收录内容。</p>}
    </section>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {preview && <article className="marketplace-preview">
      <SectionHeading>{preview.package.name}</SectionHeading>
      <p>{preview.package.description}</p>
      <p className="marketplace-source">{preview.package.author} · {preview.package.version} · {preview.package.license}</p>
      <p className="marketplace-source">{preview.source.repository} · {preview.source.commit.slice(0, 12)}</p>
      {preview.package.permissions.length > 0 && <><SectionHeading>作者声明的使用范围</SectionHeading>
        <ul>{preview.package.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul></>}
      <details><summary>{preview.package.files.length} 个文件</summary>
        {preview.package.files.map((file) => <details key={file.path}><summary>{file.path}</summary><pre>{file.text}</pre></details>)}
      </details>
      {installed.some((item) => item.state === "ready" && item.packageId === preview.package.id && item.kind === preview.package.kind &&
        item.source.repository === preview.source.repository && item.source.path === preview.source.path &&
        (item.kind === "bot" || item.botId === botId)) &&
        <label className="marketplace-target">安装到
          <select aria-label="安装对象" value={updateFor} disabled={busy}
            onChange={(event) => { setUpdateFor(event.target.value); setReviewed(false); setReplaceIdentity(false); }}>
            <option value="">{preview.package.kind === "bot" ? "新建伙伴" : "当前伙伴"}</option>
            {installed.filter((item) => item.state === "ready" && item.packageId === preview.package.id && item.kind === preview.package.kind &&
              item.source.repository === preview.source.repository && item.source.path === preview.source.path &&
              (item.kind === "bot" || item.botId === botId)).map((item) =>
              <option key={item.id} value={item.id}>更新 {item.name} · {item.version}</option>)}
          </select>
        </label>}
      {updateFor && preview.package.kind === "bot" && <label className="marketplace-review">
        <input type="checkbox" checked={replaceIdentity} disabled={busy}
          onChange={(event) => { setReplaceIdentity(event.target.checked); setReviewed(false); }} />
        同时更新公开设定（先备份原设定）
      </label>}
      <label className="marketplace-review"><input type="checkbox" checked={reviewed} disabled={busy}
        onChange={(event) => setReviewed(event.target.checked)} />已查看内容，使用这个版本</label>
      <Button disabled={!reviewed || busy} onClick={() => void install()}>
        {updateFor ? "更新这个版本" : preview.package.kind === "bot" ? "添加伙伴" : "为当前伙伴安装"}</Button>
      {catalog && <div className="marketplace-form">
        <label>标签（逗号分隔，最多 10 个）<Input aria-label="收录标签" value={tags} disabled={busy}
          onChange={(event) => setTags(event.target.value)} autoComplete="off" /></label>
        <Button variant="ghost" disabled={!reviewed || busy} onClick={() => void prepareSubmission()}>准备收录申请</Button>
      </div>}
      {submission && reviewed && <details className="marketplace-submission"><summary>收录申请</summary>
        <pre>{JSON.stringify(submission.entry, null, 2)}</pre>
        <div className="marketplace-actions">
          <Button variant="outline" onClick={() => downloadJson(submission.entry, submission.filename)}>下载收录条目</Button>
          <a className="marketplace-link" href={submission.issueUrl} target="_blank" rel="noopener noreferrer">在 GitHub 提交申请</a>
        </div>
        <p className="marketplace-source">提交后由目录维护者审核收录。</p>
      </details>}
    </article>}
    {installed.filter((item) => item.botId === botId || item.kind === "bot").map((item) => <div className="marketplace-installation" key={item.id}>
      <span>{item.name} <small>{item.version}</small></span>
      <span>{item.state === "ready" ? "已安装" : item.state === "failed" ? "安装未完成" : item.state === "revoked" ? "包内能力已停用" :
        item.state === "revoking" || item.state === "restoring" ? "能力变更未完成" : "安装中"}</span>
      {["installing", "failed"].includes(item.state) &&
        <Button variant="ghost" size="sm" disabled={busy} aria-label={`继续安装 ${item.name}`}
          onClick={() => void resumeInstallation(item)}>继续安装</Button>}
      {item.skills.length > 0 && ["ready", "revoked", "revoking", "restoring"].includes(item.state) &&
        <Button variant="ghost" size="sm" disabled={busy}
          aria-label={`${item.state === "ready" || item.state === "revoking" ? "停用" : "启用"} ${item.name} 的包内能力`}
          onClick={() => void changeAccess(item, item.state === "revoked" || item.state === "restoring")}>
          {item.state === "revoking" || item.state === "restoring" ? "重试" : item.state === "ready" ? "停用包内能力" : "启用包内能力"}
        </Button>}
    </div>)}
    {updates.filter((item) => item.state !== "ready" &&
      (item.previous.kind === "bot" || item.previous.botId === botId)).map((item) =>
      <div className="marketplace-installation" key={item.id}>
        <span>{item.previous.name} · 更新未完成</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void resumeUpdate(item)}>继续更新</Button>
      </div>)}
    {submissions.length > 0 && <details className="marketplace-submission">
      <summary>我准备过的收录申请</summary>
      {submissions.map((item) => <div className="marketplace-installation" key={item.id}>
        <span>{item.entry.name} <small>{item.entry.kind === "bot" ? "伙伴" : "能力"}{item.entry.tags.length ? ` · ${item.entry.tags.join(" · ")}` : ""}</small></span>
        <span>{item.state === "prepared" ? "已准备，等待提交" : "已提交"}</span>
        <div className="marketplace-actions">
          <Button variant="ghost" size="sm" onClick={() => downloadJson(item.entry, item.filename)}>下载条目</Button>
          <a className="marketplace-link" href={item.issueUrl} target="_blank" rel="noopener noreferrer">在 GitHub 提交</a>
        </div>
      </div>)}
      <p className="marketplace-source">申请由目录维护者审核。这里不会自动发布。</p>
    </details>}
    <PackageExport key={botId} client={client} botId={botId} onRepositorySelected={(target) => {
      ++generation.current; setBusy(false); setRepository(target.repository); setRef(target.ref); setPath(target.filename);
      setPreview(undefined); setReviewed(false); setSubmission(undefined);
    }} />
  </details>;
}

export function PackageExport({ client, botId, onRepositorySelected }: {
  client: WorkbenchClient; botId: string;
  onRepositorySelected(target: { repository: string; ref: string; filename: string }): void;
}) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [license, setLicense] = useState("");
  const [permissions, setPermissions] = useState("");
  const [identity, setIdentity] = useState("");
  const [kind, setKind] = useState<"bot" | "ability">("bot");
  const [methods, setMethods] = useState<ShareableMethod[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<PackageShare>();
  const [reviewed, setReviewed] = useState(false);
  const [uploadRepository, setUploadRepository] = useState("");
  const [uploadRef, setUploadRef] = useState("main");
  const [upload, setUpload] = useState<{ url: string; filename: string; repository: string; ref: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { ++generation.current; }, []);
  async function loadMethods() {
    const current = generation.current;
    setBusy(true); setError(undefined);
    try {
      const result = await client.request<ShareableMethod[]>("/api/marketplace/share/files", { botId });
      if (generation.current !== current) return;
      setMethods(result); setSelected([]); setPreview(undefined); setReviewed(false);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function prepare() {
    const current = generation.current;
    setBusy(true); setError(undefined); setReviewed(false); setPreview(undefined); setUpload(undefined);
    try {
      const result = await client.request<PackageShare>("/api/marketplace/share/preview", {
        botId, metadata: {
          id, kind, name, description, version, license, author,
          // The declared use stays with the package so installers can review it.
          permissions: permissions.split("\n").map((item) => item.trim()).filter(Boolean),
        },
        paths: methods?.filter((method) => selected.includes(method.id)).flatMap((method) => method.files.map((file) => file.path)) ?? [],
        ...(kind === "bot" ? { identity } : {}),
      });
      if (generation.current === current) setPreview(result);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function download() {
    if (!preview || !reviewed) return;
    const current = generation.current;
    setBusy(true); setError(undefined);
    try {
      const result = await client.request<{ package: unknown; filename: string }>("/api/marketplace/share/export", {
        id: preview.id, digest: preview.digest,
      });
      if (generation.current !== current) return;
      downloadJson(result.package, result.filename);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function prepareUpload() {
    if (!preview || !reviewed) return;
    const current = generation.current;
    setBusy(true); setError(undefined); setUpload(undefined);
    try {
      const result = await client.request<{ url: string; filename: string; repository: string; ref: string }>("/api/marketplace/share/upload", {
        id: preview.id, digest: preview.digest, repository: uploadRepository.trim(), ref: uploadRef.trim(),
      });
      if (generation.current === current) setUpload(result);
    } catch (cause) { if (generation.current === current) setError(String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <details className="marketplace-export"><summary>分享伙伴与能力</summary>
    <form onChange={() => { setPreview(undefined); setReviewed(false); setUpload(undefined); }}
      onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
      <fieldset className="marketplace-form" disabled={busy}>
      <label className="marketplace-target">分享内容<select aria-label="分享内容" value={kind} disabled={busy}
        onChange={(event) => setKind(event.target.value as "bot" | "ability")}>
        <option value="bot">伙伴与能力</option><option value="ability">仅能力</option>
      </select></label>
      <label>名称<Input aria-label="分享名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>标识<Input aria-label="分享标识" placeholder="my-bot" value={id} onChange={(event) => setId(event.target.value)} /></label>
      <label>作者<Input aria-label="公开作者" value={author} onChange={(event) => setAuthor(event.target.value)} /></label>
      <label>简介<Input aria-label="分享简介" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>版本<Input aria-label="分享版本" value={version} onChange={(event) => setVersion(event.target.value)} /></label>
      <label>许可<Input aria-label="分享许可" placeholder="例如 MIT" value={license} onChange={(event) => setLicense(event.target.value)} /></label>
      <label>使用范围（每行一条，可不填）<Textarea aria-label="使用范围" value={permissions} onChange={(event) => setPermissions(event.target.value)} /></label>
      {kind === "bot" && <label>公开设定<Textarea aria-label="公开设定" value={identity} onChange={(event) => setIdentity(event.target.value)} /></label>}
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void loadMethods()}>选择要分享的能力</Button>
      {methods?.length === 0 && <p className="marketplace-source">当前伙伴没有本机自定义能力。</p>}
      {methods?.map((method) => <div className="marketplace-share-method" key={method.id}>
        <label className="marketplace-review"><input type="checkbox" checked={selected.includes(method.id)}
          disabled={busy || !method.files.length} aria-label={`分享 ${method.name}`}
          onChange={(event) => setSelected((items) => event.target.checked ? [...items, method.id] : items.filter((item) => item !== method.id))} />
          {method.name}<small>{method.files.length} 个文件</small>
        </label>
        {method.excluded.length > 0 && <details><summary>{method.excluded.length} 个文件无法包含</summary>
          <ul>{method.excluded.map((file) => <li key={file.path}>{file.path} · {file.reason}</li>)}</ul>
        </details>}
      </div>)}
      <Button variant="outline" type="submit" disabled={busy || !name || !id || !author || !description || !version || !license ||
        (kind === "bot" ? !identity : !selected.length)}>预览分享内容</Button>
      </fieldset>
    </form>
    {preview && <article className="marketplace-share-preview">
      <SectionHeading>{preview.package.name}</SectionHeading>
      <p className="marketplace-source">{preview.package.version} · {preview.package.license}</p>
      {preview.package.files.map((file) => <details key={file.path}><summary>{file.path}</summary><pre>{file.text}</pre></details>)}
      <label className="marketplace-review"><input type="checkbox" checked={reviewed} disabled={busy}
        onChange={(event) => setReviewed(event.target.checked)} />已确认这些内容可以公开</label>
      <Button variant="outline" disabled={busy || !reviewed} onClick={() => void download()}><Download />下载分享包</Button>
      {reviewed && <details className="marketplace-upload"><summary>上传到 GitHub</summary>
        <form className="marketplace-form" onSubmit={(event) => { event.preventDefault(); void prepareUpload(); }}>
          <label>自己的仓库<Input aria-label="投稿仓库" placeholder="作者/仓库" value={uploadRepository} disabled={busy}
            onChange={(event) => { setUploadRepository(event.target.value); setUpload(undefined); }} /></label>
          <label>分支<Input aria-label="投稿分支" value={uploadRef} disabled={busy}
            onChange={(event) => { setUploadRef(event.target.value); setUpload(undefined); }} /></label>
          <Button variant="outline" type="submit" disabled={busy || !uploadRepository.trim() || !uploadRef.trim()}>准备上传</Button>
        </form>
        {upload && <><a className="marketplace-link" href={upload.url} target="_blank" rel="noopener noreferrer"
          onClick={() => onRepositorySelected(upload)}>在 GitHub 上传分享包</a>
          <p className="marketplace-source">选择刚下载的分享包。上传后回到这里查看内容，再申请收录。</p></>}
      </details>}
    </article>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </details>;
}
