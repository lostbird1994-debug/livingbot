/**
 * What a shell command is trying to do, so a step row can say it in the reader's language
 * instead of showing the program that runs it. Unknown commands stay unnamed on purpose: a
 * wrong verb is worse than the command itself.
 */
export type CommandAction =
  | "review-changes"
  | "review-history"
  | "list-files"
  | "read-file"
  | "search-content"
  | "run-tests"
  | "build"
  | "install"
  | "call-endpoint"
  | "run-script"
  | "organize-files"
  | "check-environment"
  | "change-directory";

const BY_PROGRAM: Record<string, CommandAction> = {
  ls: "list-files",
  tree: "list-files",
  du: "list-files",
  df: "list-files",
  stat: "list-files",
  file: "list-files",
  find: "list-files",
  cat: "read-file",
  head: "read-file",
  tail: "read-file",
  less: "read-file",
  more: "read-file",
  bat: "read-file",
  sed: "read-file",
  awk: "read-file",
  wc: "read-file",
  grep: "search-content",
  egrep: "search-content",
  fgrep: "search-content",
  rg: "search-content",
  ag: "search-content",
  ack: "search-content",
  pytest: "run-tests",
  jest: "run-tests",
  vitest: "run-tests",
  mocha: "run-tests",
  ava: "run-tests",
  tox: "run-tests",
  tsc: "build",
  vite: "build",
  webpack: "build",
  rollup: "build",
  esbuild: "build",
  make: "build",
  cmake: "build",
  cargo: "build",
  mvn: "build",
  gradle: "build",
  curl: "call-endpoint",
  wget: "call-endpoint",
  http: "call-endpoint",
  nc: "call-endpoint",
  node: "run-script",
  python: "run-script",
  python3: "run-script",
  tsx: "run-script",
  "ts-node": "run-script",
  deno: "run-script",
  ruby: "run-script",
  php: "run-script",
  perl: "run-script",
  bash: "run-script",
  sh: "run-script",
  zsh: "run-script",
  mkdir: "organize-files",
  cp: "organize-files",
  mv: "organize-files",
  rm: "organize-files",
  ln: "organize-files",
  touch: "organize-files",
  chmod: "organize-files",
  chown: "organize-files",
  rsync: "organize-files",
  tar: "organize-files",
  zip: "organize-files",
  unzip: "organize-files",
  gzip: "organize-files",
  pwd: "check-environment",
  whoami: "check-environment",
  id: "check-environment",
  date: "check-environment",
  uname: "check-environment",
  hostname: "check-environment",
  uptime: "check-environment",
  env: "check-environment",
  printenv: "check-environment",
  echo: "check-environment",
  which: "check-environment",
  type: "check-environment",
  ps: "check-environment",
  cd: "change-directory",
  pushd: "change-directory",
  popd: "change-directory",
};

const BY_GIT: Record<string, CommandAction> = {
  diff: "review-changes",
  status: "review-changes",
  show: "review-changes",
  log: "review-history",
  reflog: "review-history",
  blame: "review-history",
  shortlog: "review-history",
};

const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_SUBCOMMANDS: Record<string, CommandAction> = {
  test: "run-tests",
  install: "install",
  i: "install",
  add: "install",
  ci: "install",
  build: "build",
  run: "run-script",
  exec: "run-script",
};

/** Splits a command line on the shell operators that start a new command. */
function segments(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Flags that consume the token after them, so it is a value rather than a command word. */
const VALUE_FLAGS = new Set([
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "-w",
  "--workspace",
]);

/** Segment words that are neither flags nor a flag's value. */
function positional(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (VALUE_FLAGS.has(word)) {
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) kept.push(word);
  }
  return kept;
}

/** The program a segment runs, once wrappers, `VAR=value` prefixes and flags are out of the way. */
function programOf(segment: string): { program: string; rest: string[] } | undefined {
  const words = segment.split(/\s+/).filter(Boolean);
  while (words.length) {
    const word = words[0]!;
    const wrapper =
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ||
      /^(?:sudo|time|nohup|command|builtin)$/.test(word) ||
      word.startsWith("-");
    if (!wrapper) break;
    words.shift();
  }
  const first = words.shift();
  if (!first) return undefined;
  return { program: first.split("/").pop() ?? first, rest: words };
}

function segmentAction(segment: string): CommandAction | undefined {
  const parsed = programOf(segment);
  if (!parsed) return undefined;
  const { program, rest } = parsed;
  const words = positional(rest);
  if (program === "git") {
    for (const word of words) if (BY_GIT[word]) return BY_GIT[word];
    return undefined;
  }
  // `pnpm --filter web build` and `pnpm vitest run` both name their intent in the arguments.
  if (PACKAGE_RUNNERS.has(program)) {
    for (const word of words) {
      const action = PACKAGE_SUBCOMMANDS[word] ?? BY_PROGRAM[word];
      if (action) return action;
    }
    return undefined;
  }
  const sub = words[0];
  if (program === "go") return sub === "test" ? "run-tests" : sub === "build" ? "build" : undefined;
  if ((program === "pip" || program === "pip3" || program === "uv") && rest.includes("install"))
    return "install";
  if (program === "brew" || program === "apt" || program === "apt-get") return "install";
  return BY_PROGRAM[program];
}

/** Words that are shell syntax rather than an argument. */
const NOISE = [/^\d*[<>]/, /^[<>]/, /^&>/, /^\|$/, /^&&?$/];

/** A segment's words without flags, redirections, or the values those consume. */
function argumentWords(words: readonly string[]): string[] {
  const kept: string[] = [];
  let afterRedirect = false;
  for (const word of words) {
    if (NOISE.some((pattern) => pattern.test(word))) {
      // `2>/dev/null` and `> file` both end the argument list worth naming.
      afterRedirect = !word.startsWith("-");
      continue;
    }
    if (afterRedirect) {
      afterRedirect = false;
      continue;
    }
    if (word.startsWith("-")) continue;
    kept.push(word);
  }
  return kept;
}

/** Subcommand words that describe the verb, never the object. */
const RUNNERS = new Set<string>([
  ...Object.keys(BY_GIT),
  ...Object.keys(PACKAGE_SUBCOMMANDS),
  "go",
  "pip",
  "pip3",
  "uv",
]);

const unquote = (word: string) => word.replace(/^["']|["']$/g, "");
/** What to show for a path: its own name, the way a chat names a file. */
const shown = (word: string) => {
  const value = unquote(word);
  const name = value.replace(/\/+$/, "").split("/").pop() || value;
  return name.length > 60 ? `${name.slice(0, 60)}…` : name;
};

/** The thing a call acted on, so a row can say what, not just how. */
function pickTarget(action: CommandAction, words: readonly string[]): string | undefined {
  if (action === "call-endpoint") {
    const url = words.find((word) => /^https?:\/\//.test(word));
    if (url) {
      try {
        const parsed = new URL(unquote(url));
        // A URL keeps its host; only the length is trimmed.
        const endpoint = `${parsed.host}${parsed.pathname}`;
        return endpoint.length > 60 ? `${endpoint.slice(0, 60)}…` : endpoint;
      } catch {
        return undefined;
      }
    }
  }
  if (action === "run-script") {
    const moduleIndex = words.findIndex((word) => word === "-m" || word === "--module");
    const fromModule = moduleIndex >= 0 ? words[moduleIndex + 1] : undefined;
    if (fromModule) return shown(fromModule);
    const script = words.find((word) => !word.startsWith("-"));
    return script ? shown(script) : undefined;
  }
  const candidate = words.at(-1);
  if (!candidate) return undefined;
  const value = unquote(candidate);
  if (!/[./\\_=-]/.test(value) && value.length > 24) return undefined;
  return shown(value);
}

/** The file, command or URL a command names, if it names one. */
export function commandTarget(command: string | undefined): string | undefined {
  if (!command) return undefined;
  for (const segment of segments(command)) {
    const action = segmentAction(segment);
    if (!action) continue;
    const parsed = programOf(segment);
    if (!parsed) continue;
    const words = argumentWords(parsed.rest);
    // `git diff --stat` names its verb first; that verb is not what the call acted on.
    if (RUNNERS.has(words[0] ?? "")) words.shift();
    const target = pickTarget(action, words);
    if (target) return target;
  }
  return undefined;
}

/**
 * The action a command line performs. A chain reports its most specific step, so
 * `cd app && pnpm test` reads as running tests rather than changing directory.
 */
export function commandAction(command: string | undefined): CommandAction | undefined {
  if (!command) return undefined;
  const actions = segments(command)
    .map(segmentAction)
    .filter((action): action is CommandAction => action !== undefined);
  return actions.find((action) => action !== "change-directory") ?? actions[0];
}
