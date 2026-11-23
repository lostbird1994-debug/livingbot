/** Exported code keeps a faithful type and filename; the fence language is untrusted input. */
export type CodeExport = { name: string; mediaType: string; preview: boolean };

const formats: Record<string, { extension: string; mediaType: string }> = {
  html: { extension: "html", mediaType: "text/html;charset=utf-8" },
  svg: { extension: "svg", mediaType: "image/svg+xml" },
  json: { extension: "json", mediaType: "application/json;charset=utf-8" },
  jsonl: { extension: "jsonl", mediaType: "application/x-ndjson;charset=utf-8" },
  ndjson: { extension: "ndjson", mediaType: "application/x-ndjson;charset=utf-8" },
  csv: { extension: "csv", mediaType: "text/csv;charset=utf-8" },
  tsv: { extension: "tsv", mediaType: "text/tab-separated-values;charset=utf-8" },
  markdown: { extension: "md", mediaType: "text/markdown;charset=utf-8" },
  css: { extension: "css", mediaType: "text/css;charset=utf-8" },
  xml: { extension: "xml", mediaType: "application/xml;charset=utf-8" },
  yaml: { extension: "yaml", mediaType: "application/yaml;charset=utf-8" },
  toml: { extension: "toml", mediaType: "application/toml;charset=utf-8" },
  sql: { extension: "sql", mediaType: "text/plain;charset=utf-8" },
};

const aliases: Record<string, string> = {
  htm: "html", md: "markdown", mkd: "markdown", yml: "yaml", jsonc: "json",
  bash: "sh", zsh: "sh", shell: "sh", console: "sh", python: "py", node: "js",
};

const code = (extension: string): { extension: string; mediaType: string } =>
  ({ extension, mediaType: "text/plain;charset=utf-8" });

const languages: Record<string, { extension: string; mediaType: string }> = {
  js: code("js"), mjs: code("mjs"), cjs: code("cjs"), jsx: code("jsx"), ts: code("ts"),
  tsx: code("tsx"), py: code("py"), rb: code("rb"), go: code("go"), rs: code("rs"),
  java: code("java"), kt: code("kt"), swift: code("swift"), php: code("php"),
  c: code("c"), h: code("h"), cpp: code("cpp"), cs: code("cs"), sh: code("sh"),
  diff: code("diff"), patch: code("patch"), ini: code("ini"), log: code("log"),
};

/** Only a recognized fence language becomes an extension; anything else stays `.txt`. */
export function fenceLanguage(language: string): string {
  const token = language.trim().toLowerCase().split(/[\s:{]/)[0]?.replace(/^language-/, "") ?? "";
  const resolved = aliases[token] ?? token;
  return /^[a-z0-9+#-]{1,12}$/.test(resolved) ? resolved : "";
}

export function codeExport(language: string): CodeExport {
  const resolved = fenceLanguage(language);
  const format = formats[resolved] ?? languages[resolved];
  return format
    ? { name: `output.${format.extension}`, mediaType: format.mediaType, preview: resolved === "html" || resolved === "svg" }
    : { name: "output.txt", mediaType: "text/plain;charset=utf-8", preview: false };
}
