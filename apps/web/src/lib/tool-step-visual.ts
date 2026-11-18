/** Which family a tool belongs to, which picks its icon and the verb a step row leads with. */
export type ToolFamily = "read" | "write" | "search" | "run" | "browse" | "control" | "tool";

const FAMILIES: Record<string, ToolFamily> = {
  read: "read",
  read_file: "read",
  open_path: "read",
  attach_file: "read",
  list_files: "read",
  ls: "read",
  dir_list: "read",
  read_memory: "read",
  memory_get: "read",
  skill_read: "read",
  write: "write",
  edit: "write",
  apply_patch: "write",
  write_file: "write",
  write_memory: "write",
  save_shared_memory: "write",
  skill_create: "write",
  skill_update: "write",
  skill_delete: "write",
  remember: "write",
  find_tool: "search",
  find: "search",
  grep: "search",
  web_search: "search",
  x_search: "search",
  search_memory: "search",
  memory_search: "search",
  shell: "run",
  exec: "run",
  bash: "run",
  user_computer_shell: "run",
  web_fetch: "browse",
  browser_navigate: "browse",
  browser_snapshot: "browse",
  browser_act: "browse",
  computer_observe: "control",
  computer_act: "control",
  user_computer_observe: "control",
  user_computer_act: "control",
};

/** Names a runtime adds after this list was written still land in a sensible family. */
const FAMILY_HINTS: ReadonlyArray<[RegExp, ToolFamily]> = [
  [/patch|write|edit|save|create/i, "write"],
  [/exec|shell|bash|command|run/i, "run"],
  [/search|find|grep|query|lookup/i, "search"],
  [/browse|fetch|url|page/i, "browse"],
  [/computer|desktop|screen|mouse|keyboard|click/i, "control"],
  [/read|open|list|view|cat|memory/i, "read"],
];

/**
 * A step recorded before tools were labelled has no family and keeps the tool icon, as does a
 * connector's tool or a name no hint fits.
 */
export function toolFamily(tool: string | undefined): ToolFamily {
  if (!tool) return "tool";
  const known = FAMILIES[tool];
  if (known) return known;
  for (const [pattern, family] of FAMILY_HINTS) if (pattern.test(tool)) return family;
  return "tool";
}

/** A long path reads as its own name; a short one stays as written. */
export function shortDetail(detail: string): string {
  if (detail.length <= 40 || !detail.includes("/")) return detail;
  const name = detail.replace(/\/+$/, "").split("/").pop();
  return name || detail;
}
