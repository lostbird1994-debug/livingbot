import { FIND_TOOL, USE_TOOL } from "./builtin-tool-bridge.js";
import { sanitizeSensitiveText } from "./pi-runtime-errors.js";

const DETAIL_LIMIT = 90;

/** One bounded line of what a call acted on: never a whole prompt, command output or secret. */
export function activityDetail(value: unknown): string {
  const text = sanitizeSensitiveText(String(value ?? ""))
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** Origin + path only for activity chips; drop userinfo, query, and fragment. */
export function redactActivityUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    // Never echo unparsed input — it may still contain userinfo/secrets.
    return "[invalid URL]";
  }
}

/** The file an apply_patch call touches, which the patch header names. */
function patchedPath(input: unknown): string | undefined {
  const match = /\*\*\* (?:Add|Update|Delete) File: (.+)/.exec(String(input ?? ""));
  return match ? activityDetail(match[1]) : undefined;
}

/**
 * What a call acted on — a file, a command, a query — as a bare value rather than a sentence, so
 * each runtime's step rows can pair it with their own localized verb and icon.
 */
const TARGETS: Record<string, (args: Record<string, unknown>) => string | undefined> = {
  shell: (a) => activityDetail(a.command),
  exec: (a) => activityDetail(a.command),
  bash: (a) => activityDetail(a.command),
  user_computer_shell: (a) => activityDetail(a.command),
  user_computer_observe: (a) => activityDetail(a.app),
  user_computer_act: (a) => activityDetail(a.app),
  read: (a) => activityDetail(a.path),
  write: (a) => activityDetail(a.path),
  edit: (a) => activityDetail(a.path),
  read_file: (a) => activityDetail(a.path),
  write_file: (a) => activityDetail(a.path),
  open_path: (a) => activityDetail(a.path),
  attach_file: (a) => activityDetail(a.path),
  read_memory: (a) => activityDetail(a.path),
  write_memory: (a) => activityDetail(a.path),
  save_shared_memory: (a) => activityDetail(a.path),
  memory_get: (a) => activityDetail(a.path),
  list_files: (a) => activityDetail(a.path ?? "."),
  ls: (a) => activityDetail(a.path ?? a.dir ?? "."),
  dir_list: (a) => activityDetail(a.path ?? a.dir ?? "."),
  grep: (a) => activityDetail(a.pattern ?? a.query),
  find: (a) => activityDetail(a.pattern ?? a.query),
  search_memory: (a) => activityDetail(a.query),
  memory_search: (a) => activityDetail(a.query),
  web_search: (a) => activityDetail(a.query),
  x_search: (a) => activityDetail(a.query),
  web_fetch: (a) => activityDetail(redactActivityUrl(a.url)),
  browser_navigate: (a) => activityDetail(redactActivityUrl(a.url)),
  add_mcp_server: (a) => activityDetail(a.name),
  run_subagent: (a) => activityDetail(a.name),
  create_space: (a) => activityDetail(a.name),
  create_group: (a) => activityDetail(a.name),
  update_group: (a) => activityDetail(a.group_name ?? a.name),
  create_child_routine: (a) => activityDetail(a.name),
  apply_patch: (a) => patchedPath(a.input ?? a.patch),
  skill_read: (a) =>
    a.file ? `${activityDetail(a.file)} · ${activityDetail(a.name)}` : activityDetail(a.name),
  skill_create: (a) => activityDetail(a.name ?? "skill"),
  skill_update: (a) => activityDetail(a.name ?? a.skillId),
  skill_delete: (a) => activityDetail(a.name ?? a.skillId),
};

/** Argument fields a tool nobody listed here is still likely to describe itself with. */
const TARGET_FIELDS = [
  "command",
  "cmd",
  "path",
  "file",
  "file_path",
  "url",
  "query",
  "pattern",
  "dir",
  "cwd",
] as const;

export function toolCallTarget(toolName: string, args: unknown): string | undefined {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === USE_TOOL) return toolCallTarget(String(record.name), record.arguments);
  if (toolName === FIND_TOOL) return undefined;
  const named = TARGETS[toolName];
  if (named) return named(record);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  for (const field of TARGET_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return activityDetail(value);
  }
  return undefined;
}

/**
 * What the call was for, when the tool's schema asks the model to say it. WorkBuddy's shell tool
 * has a required `description`; we give OpenClaw's exec one with the same meaning
 * (`scripts/patch-openclaw-exec-description.mjs`).
 */
export function toolCallAction(toolName: string, args: unknown): string | undefined {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === USE_TOOL) return toolCallAction(String(record.name), record.arguments);
  const described = typeof record.description === "string" ? record.description.trim() : "";
  return described ? activityDetail(described) : undefined;
}

/** Prose for a live status line; `{t}` is what `toolCallTarget` resolved for the same call. */
const PROSE: Record<string, string> = {
  shell: "Running: {t}",
  exec: "Running: {t}",
  bash: "Running: {t}",
  user_computer_shell: "Running on your computer: {t}",
  user_computer_observe: "Looking at {t}",
  user_computer_act: "Using {t}",
  read: "Reading {t}",
  write: "Writing {t}",
  edit: "Editing {t}",
  read_file: "Reading {t}",
  write_file: "Writing {t}",
  list_files: "Listing {t}",
  ls: "Listing {t}",
  dir_list: "Listing {t}",
  attach_file: "Attaching {t}",
  open_path: "Opening {t}",
  apply_patch: "Editing {t}",
  add_mcp_server: "Connecting MCP server: {t}",
  browser_navigate: "Opening page: {t}",
  run_subagent: "Delegating to helper: {t}",
  create_space: "Creating space: {t}",
  create_group: "Creating group: {t}",
  update_group: "Updating group: {t}",
  create_child_routine: "Scheduling routine: {t}",
  read_memory: "Reading memory: {t}",
  memory_get: "Reading memory: {t}",
  write_memory: "Rewriting memory: {t}",
  save_shared_memory: "Saving shared memory: {t}",
  search_memory: "Searching memory: {t}",
  memory_search: "Searching memory: {t}",
  web_search: "Searching the web: {t}",
  x_search: "Searching X: {t}",
  web_fetch: "Reading page: {t}",
  skill_create: "Creating skill: {t}",
  skill_update: "Updating skill: {t}",
  skill_delete: "Deleting skill: {t}",
};

/** Status lines for calls with no target worth naming. */
const PROSE_UNTARGETED: Record<string, string> = {
  find_tool: "Finding a tool",
  render_plot: "Rendering a chart",
  computer_observe: "Looking at the screen",
  browser_snapshot: "Reading the page",
  browser_act: "Using the page",
  computer_act: "Operating the computer",
  list_fleet: "Checking your bots",
  organize_bot: "Organizing the sidebar",
  set_child_instructions: "Rewriting a bot's instructions",
  set_child_bot_model: "Setting a bot's model",
  remember: "Saving a note to memory",
  process: "Waiting on a running command",
  cron: "Scheduling a job",
  message: "Sending a message",
  update_plan: "Updating the plan",
  sessions_list: "Checking open sessions",
  sessions_history: "Reading a session",
  sessions_send: "Messaging a session",
  sessions_spawn: "Starting a helper",
  sessions_yield: "Waiting for other work",
  session_status: "Checking a session",
  subagents: "Checking helpers",
};

/** One human-readable line describing a tool call, shown live in the thread. */
export function describeToolActivity(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === USE_TOOL) return describeToolActivity(String(record.name), record.arguments);
  const untargeted = PROSE_UNTARGETED[toolName];
  if (untargeted) return untargeted;
  if (toolName === "skill_read")
    return record.file
      ? `Reading ${activityDetail(record.file)} from ${activityDetail(record.name)}`
      : `Reading skill: ${activityDetail(record.name)}`;
  const target = toolCallTarget(toolName, args);
  const prose = PROSE[toolName];
  if (prose) return prose.replace("{t}", target ?? "");
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
  return target ? `Using ${toolName}: ${target}` : `Using ${toolName}`;
}
