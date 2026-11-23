import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type RuntimePaths = {
  root: string;
  home: string;
  state: string;
  config: string;
  workspaces: string;
  logs: string;
  temporary: string;
};

export function containsPath(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function runtimePaths(root = join(homedir(), "Library", "Application Support", "LivingBot 2")): RuntimePaths {
  if (!isAbsolute(root)) throw new Error("The data directory must be absolute");
  const canonical = resolve(root);
  if (canonical === sep || canonical === homedir()) throw new Error("The data directory must be application-specific");
  return {
    root: canonical,
    home: join(canonical, "kernel-home"),
    state: join(canonical, "kernel-state"),
    config: join(canonical, "kernel-config.json"),
    workspaces: join(canonical, "workspaces"),
    logs: join(canonical, "logs"),
    temporary: join(canonical, "temporary"),
  };
}

export async function preparePaths(paths: RuntimePaths, protectedRoots: string[] = []): Promise<void> {
  for (const protectedRoot of protectedRoots) {
    if (containsPath(protectedRoot, paths.root) || containsPath(paths.root, protectedRoot)) {
      throw new Error("The new data directory overlaps a protected previous-version directory");
    }
  }
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const actual = await realpath(paths.root);
  for (const protectedRoot of protectedRoots) {
    const protectedActual = await realpath(protectedRoot).catch(() => resolve(protectedRoot));
    if (containsPath(protectedActual, actual) || containsPath(actual, protectedActual)) {
      throw new Error("The new data directory resolves into a protected previous-version directory");
    }
  }
  for (const dir of [paths.home, paths.state, paths.workspaces, paths.logs, paths.temporary]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = await realpath(dir);
    if (!containsPath(actual, target)) throw new Error("An application directory escapes the data root");
  }
}

export function runtimeEnvironment(paths: RuntimePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: paths.home,
    TMPDIR: paths.temporary,
    OPENCLAW_HOME: paths.home,
    OPENCLAW_STATE_DIR: paths.state,
    OPENCLAW_CONFIG_PATH: paths.config,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
