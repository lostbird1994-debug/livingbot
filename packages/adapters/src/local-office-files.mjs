import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const within = (root, path) => path === root || path.startsWith(root + sep);

/** Files opened in an external editor are private copies; exports never replace a source. */
export class LocalOfficeFiles {
  constructor(root, state) {
    this.root = resolve(root);
    this.state = resolve(state);
    this.opened = new Set();
  }

  async input(path) {
    if (!isAbsolute(path)) throw new Error("Use an absolute workspace file path");
    const root = await realpath(this.root);
    const source = await realpath(path);
    if ((!within(root, source) && !within(await realpath(this.state), source)) || (await lstat(path)).isSymbolicLink()) throw new Error("File is outside the configured workspace");
    if (!(await lstat(source)).isFile()) throw new Error("Open a regular file");
    const directory = join(this.state, "inputs", randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const copy = join(directory, basename(source));
    await copyFile(source, copy, constants.COPYFILE_EXCL);
    return copy;
  }

  async output(path, internal = false) {
    if (!isAbsolute(path)) throw new Error("Use an absolute output file path");
    const target = resolve(path);
    const root = internal && within(await realpath(this.state), target) ? await realpath(this.state) : await realpath(this.root);
    if (!within(root, target) || (!internal && !relative(root, target).split(sep).some((part) => part === "tasks" || part === "projects"))) {
      throw new Error("Deliver outputs under a workspace tasks/ or projects/ directory");
    }
    // Output directories are created by the native workspace tools, not by this external editor.
    if (!within(root, await realpath(dirname(target)))) throw new Error("Output directory escapes the workspace");
    try { await lstat(target); throw new Error("Output already exists; choose a new file name"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const directory = join(this.state, "outputs", randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { staged: join(directory, basename(target)), target };
  }

  async publish(staged, target) {
    if (!within(await realpath(this.state), await realpath(staged))) throw new Error("Output is not owned by this editor");
    if (!within(await realpath(this.root), await realpath(dirname(target))) && !within(await realpath(this.state), await realpath(dirname(target)))) throw new Error("Output directory escapes the workspace");
    const parent = dirname(target), identity = await stat(parent, { bigint: true });
    // Pin the receiver's cwd to the reviewed directory. A changed ancestor cannot redirect this write.
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", `
      const fs = require('node:fs');
      const [source, name, dev, ino] = process.argv.slice(1);
      try {
      const cwd = fs.statSync('.', {bigint:true});
      if (String(cwd.dev) !== dev || String(cwd.ino) !== ino) throw Error('Output directory changed');
      fs.copyFileSync(source, name, fs.constants.COPYFILE_EXCL);
      process.stdout.write(JSON.stringify({ok:true}));
      } catch(error) { process.stdout.write(JSON.stringify({ok:false, code:error.code, message:error.message})); }
    `, staged, basename(target), String(identity.dev), String(identity.ino)], { cwd: parent, timeout: 30_000 });
    const result = JSON.parse(stdout);
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
    return target;
  }

  own(id) { if (typeof id === "string") this.opened.add(id); }
  assertEditor(id) { if (!id || !this.opened.has(id)) throw new Error("Open this file through the current editor connection first"); }
}
