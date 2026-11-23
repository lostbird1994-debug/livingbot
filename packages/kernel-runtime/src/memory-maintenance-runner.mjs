import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { RecoverableMemoryFiles } from "./recoverable-memory-files.ts";

// Private operation input is written by the configured kernel composition root.
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
if (input.format !== "livingbot-memory-maintenance-v1" || input.action !== "forget") throw new Error("Invalid native maintenance action");
const requireKernel = createRequire(input.entry);
const sdk = await import(pathToFileURL(requireKernel.resolve("openclaw/plugin-sdk/agent-workspace-runtime")).href);
const memoryFs = await import(pathToFileURL(requireKernel.resolve("openclaw/plugin-sdk/memory-core-host-engine-fs")).href);
const files = new RecoverableMemoryFiles({ workspace: input.workspace, trash: input.trash, journal: input.journal });
const unsupported = async () => { throw new Error("Operation unavailable in forgetting maintenance"); };
const release = sdk.registerAgentWorkspaceAccess(input.workspace, {
  bridge: { readFile: unsupported, writeFile: unsupported, stat: unsupported },
  memoryFiles: {
    assertCurrent() {},
    listFiles: (...args) => memoryFs.listMemoryFiles(...args),
    inspectFile: memoryFs.buildFileEntry, readFile: memoryFs.readMemoryFile,
    readForIndexing: unsupported, buildMultimodalChunk: unsupported, watch: unsupported,
    maintenance: {
      readFile: files.readFile.bind(files), stat: files.stat.bind(files),
      listDirectory: files.listDirectory.bind(files), mkdir: files.mkdir.bind(files),
      rename: unsupported, resolveWritePath: files.checkedPath.bind(files),
      commitContent: files.commitContent.bind(files),
      resolveDreamsPath: unsupported, readDreams: unsupported, writeDreams: unsupported,
      replaceReport: unsupported, appendCorpus: unsupported,
    },
  },
});
process.argv = [process.execPath, input.entry, "memory", "forget", "--agent", input.agentId,
  ...input.sessions.flatMap((session) => ["--session", session]), "--json"];
// Official CLI owns lineage, database mutations, tombstones and result reporting.
await import(pathToFileURL(input.entry).href);
process.once("beforeExit", release);
