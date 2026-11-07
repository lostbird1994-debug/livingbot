import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// A helper process owns its cwd. Every descent verifies the opened directory's inode before
// touching its contents, so replacing an ancestor pathname with a link cannot redirect removal.
const REMOVE_CHILDREN = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const expected = JSON.parse(process.argv[1]);
const names = JSON.parse(process.argv[2]);
const same = (a,b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const check = () => { if (!same(fs.statSync('.', {bigint:true}), expected)) throw new Error('directory changed'); };
try {
  check();
  const trash = path.join(os.homedir(), '.Trash', 'rakazo-native');
  fs.mkdirSync(trash, {recursive:true, mode:0o700});
  for (const name of names) {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('invalid child');
    check();
    try { fs.lstatSync(name); } catch(error) { if(error.code === 'ENOENT') continue; throw error; }
    const destination = path.join(trash, Date.now()+'-'+crypto.randomUUID()+'-'+name);
    const original = path.resolve(name);
    fs.renameSync(name, destination);
    fs.appendFileSync(path.join(trash, 'recovery.jsonl'), JSON.stringify({original,destination,time:new Date().toISOString()})+'\n', {mode:0o600});
  }
} catch { process.exitCode = 1; }
`;

export async function removeOwnedWorkspaceChildren(
  parent: string,
  names: string[],
  identity: { dev: bigint; ino: bigint },
  signal: AbortSignal,
) {
  await run(
    process.execPath,
    [
      "-e",
      REMOVE_CHILDREN,
      JSON.stringify({ dev: String(identity.dev), ino: String(identity.ino) }),
      JSON.stringify(names),
    ],
    {
      cwd: parent,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      signal,
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
}

export async function moveNativePathToTrash(file: string) {
  const { lstat } = await import("node:fs/promises");
  const path = await import("node:path");
  try { await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const parent = path.dirname(file);
  const identity = await lstat(parent, { bigint: true });
  await removeOwnedWorkspaceChildren(parent, [path.basename(file)], identity, new AbortController().signal);
}
