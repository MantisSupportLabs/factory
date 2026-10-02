#!/usr/bin/env node
/** Host-only restore into an isolated directory. Never open the live application DB. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  parseArguments,
  safeRelativePath,
  regularFile,
  sha256,
  listFiles,
  stageDirectory,
  validateDatabase,
  validateDocumentReferences,
} from "./backup.mjs";

function validateEntry(value, expectedPath) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid manifest file entry");
  safeRelativePath(value.path);
  if (
    expectedPath
      ? value.path !== expectedPath
      : !value.path.startsWith("documents/")
  )
    throw new Error("Invalid manifest file path");
  if (
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error("Invalid manifest file size or SHA256");
  }
  return value;
}

export async function verifyArchive(sourceDirectory) {
  const source = path.resolve(sourceDirectory);
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error("Backup source must be a regular directory");
  await regularFile(path.join(source, "manifest.json"));
  let manifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(source, "manifest.json"), "utf8"),
    );
  } catch {
    throw new Error("Backup manifest is not valid JSON");
  }
  if (
    !manifest ||
    manifest.format !== ARCHIVE_FORMAT ||
    manifest.version !== ARCHIVE_VERSION ||
    !Array.isArray(manifest.documents) ||
    typeof manifest.created_at !== "string" ||
    !Number.isFinite(new Date(manifest.created_at).getTime())
  ) {
    throw new Error("Unsupported or invalid backup manifest");
  }
  const entries = [
    validateEntry(manifest.database, "snapshot.sqlite"),
    ...manifest.documents.map((value) => validateEntry(value)),
  ];
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new Error("Duplicate paths in backup manifest");
  const documentStat = await fs.lstat(path.join(source, "documents"));
  if (!documentStat.isDirectory() || documentStat.isSymbolicLink())
    throw new Error("Backup documents must be a regular directory");
  const expected = [
    "manifest.json",
    ...entries.map((entry) => entry.path),
  ].sort();
  const actual = (await listFiles(source)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Backup files do not match the manifest");
  for (const entry of entries) {
    const filename = path.join(source, entry.path),
      stat = await regularFile(filename);
    if (
      stat.size !== entry.size_bytes ||
      (await sha256(filename)) !== entry.sha256
    )
      throw new Error(`Backup hash verification failed: ${entry.path}`);
  }
  validateDatabase(path.join(source, "snapshot.sqlite"));
  await validateDocumentReferences(
    path.join(source, "snapshot.sqlite"),
    path.join(source, "documents"),
  );
  return manifest;
}

export async function restoreToDirectory(sourceDirectory, destination) {
  const source = path.resolve(sourceDirectory),
    output = path.resolve(destination);
  if (output === source || output.startsWith(source + path.sep))
    throw new Error("Restore destination must be outside the backup archive");
  const manifest = await verifyArchive(source);
  return stageDirectory(output, async (stage) => {
    await fs.copyFile(
      path.join(source, "snapshot.sqlite"),
      path.join(stage, "dirtworks.db"),
    );
    await fs.chmod(path.join(stage, "dirtworks.db"), 0o600);
    await fs.mkdir(path.join(stage, "documents"), { mode: 0o700 });
    for (const entry of manifest.documents) {
      const copied = path.join(stage, entry.path);
      await fs.mkdir(path.dirname(copied), { recursive: true, mode: 0o700 });
      await fs.copyFile(path.join(source, entry.path), copied);
      await fs.chmod(copied, 0o600);
      const stat = await regularFile(copied);
      if (
        stat.size !== entry.size_bytes ||
        (await sha256(copied)) !== entry.sha256
      )
        throw new Error(`Backup changed during restore: ${entry.path}`);
    }
    const database = path.join(stage, "dirtworks.db");
    if ((await sha256(database)) !== manifest.database.sha256)
      throw new Error("Backup database changed during restore");
    validateDatabase(database);
    await validateDocumentReferences(database, path.join(stage, "documents"));
    await fs.writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return {
      database: path.join(output, "dirtworks.db"),
      documents: manifest.documents.length,
    };
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArguments(process.argv.slice(2), ["--from", "--into"]);
    if (!args["--from"] || !args["--into"])
      throw new Error(
        "Usage: node server/scripts/restore.mjs --from BACKUP_DIRECTORY --into NEW_OR_EMPTY_DIRECTORY",
      );
    const result = await restoreToDirectory(args["--from"], args["--into"]);
    console.log(
      `Restore complete: ${result.database} (${result.documents} document files). Start the stopped server with DB_PATH set to this file.`,
    );
  } catch (error) {
    console.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  }
}
