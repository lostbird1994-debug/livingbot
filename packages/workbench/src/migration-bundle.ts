import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { MigrationBundle } from "./migration.ts";
import { readMigrationBackupFile, verifyMigrationBackup } from "./migration-backup.ts";

export type MigrationBundleSource = Omit<MigrationBundle["bots"][number], "source"> & {
  backup: string;
  supplements?: { backup: string; directory: string }[];
  profile?: Record<string, unknown>;
};

/** Prepare portable sources from verified backups. Does not activate agents or touch old data. */
export async function prepareMigrationBundle(destination: string, sources: MigrationBundleSource[]): Promise<string> {
  if (!isAbsolute(destination) || !sources.length || sources.length > 64 ||
      new Set(sources.map((item) => item.sourceIdentity)).size !== sources.length) {
    throw new Error("Select distinct migration sources and an absolute output directory");
  }
  const manifests = await Promise.all(sources.map((item) => verifyMigrationBackup(item.backup)));
  const supplements = await Promise.all(sources.map(async (item) => Promise.all((item.supplements ?? []).map(async (extra) => {
    if (!extra.directory || isAbsolute(extra.directory) || extra.directory.includes("\\") ||
        extra.directory.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Supplement destination must be a relative directory");
    }
    return { ...extra, manifest: await verifyMigrationBackup(extra.backup) };
  }))));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(destination, "migration-package-"));
  const bundle: MigrationBundle = { format: "livingbot-migration-v1", bots: [] };
  for (const [index, item] of sources.entries()) {
    const source = `bots/bot-${index + 1}`;
    const workspace = join(root, source);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const inputs = [
      { backup: item.backup, directory: "", manifest: manifests[index] },
      ...supplements[index],
    ];
    const copied = new Map<string, Buffer>();
    const excluded = [...(item.sourceExclusions ?? [])];
    for (const input of inputs) {
      excluded.push(...input.manifest.excluded.map((entry) => ({
        path: input.directory ? `${input.directory}/${entry.path}` : entry.path, reason: entry.reason,
      })));
      for (const file of input.manifest.files) {
        const path = input.directory ? `${input.directory}/${file.path}` : file.path;
        const bytes = await readMigrationBackupFile(input.backup, file);
        const existing = copied.get(path);
        if (existing) {
          if (!existing.equals(bytes)) throw new Error(`Conflicting migration sources: ${path}`);
          continue;
        }
        const target = join(workspace, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
        copied.set(path, bytes);
      }
    }
    await mkdir(join(workspace, "profile"), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "profile", "livingbot-migration-source.json"), JSON.stringify({
      format: "livingbot-profile-v1", sourceIdentity: item.sourceIdentity,
      name: item.name, description: item.description ?? "", identity: item.identity ?? "",
      ...(item.profile ? { original: item.profile } : {}),
      supplementalSources: supplements[index].map((extra) => ({
        source: extra.manifest.source, directory: extra.directory,
      })),
      excluded,
    }, null, 2), { flag: "wx", mode: 0o600 });
    bundle.bots.push({
      sourceIdentity: item.sourceIdentity, source, name: item.name,
      ...(item.description ? { description: item.description } : {}),
      ...(item.identity ? { identity: item.identity } : {}),
      ...(item.color ? { color: item.color } : {}),
      sourceExclusions: excluded,
    });
  }
  const path = join(root, "livingbot-migration.json");
  await writeFile(path, JSON.stringify(bundle, null, 2), { flag: "wx", mode: 0o600 });
  return path;
}
