#!/usr/bin/env node
/** Host-only recovery archive. Never initialize or change application data. */
import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARCHIVE_FORMAT = "dirtworks-host-backup";
export const ARCHIVE_VERSION = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultDatabasePath = path.resolve(here, "../data/dirtworks.db");

export function parseArguments(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const option = argv[i];
    if (
      !allowed.includes(option) ||
      result[option] ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    ) {
      throw new Error(
        `Invalid arguments. Allowed options: ${allowed.join(", ")}`,
      );
    }
    result[option] = argv[i + 1];
  }
  return result;
}

export async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

export function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error("Archive contains an unsafe relative path");
  }
  if (value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Archive contains an unsafe relative path");
  }
  return value;
}

export async function regularFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Expected a regular file: ${filename}`);
  return stat;
}

export async function fileEntry(directory, relative) {
  safeRelativePath(relative);
  const filename = path.join(directory, relative);
  const stat = await regularFile(filename);
  return {
    path: relative,
    size_bytes: stat.size,
    sha256: await sha256(filename),
  };
}

export async function listFiles(directory, prefix = "") {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeRelativePath(relative);
    if (entry.isSymbolicLink())
      throw new Error(
        `Symbolic links are not supported in backups: ${relative}`,
      );
    if (entry.isDirectory())
      result.push(
        ...(await listFiles(path.join(directory, entry.name), relative)),
      );
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unsupported file type in backup: ${relative}`);
  }
  return result;
}

export async function assertEmptyDestination(destination) {
  let stat;
  try {
    stat = await fs.lstat(destination);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.readdir(destination)).length
  ) {
    throw new Error(
      "Destination must be a new or empty directory; existing data will never be overwritten",
    );
  }
}

export async function stageDirectory(destination, operation) {
  await assertEmptyDestination(destination);
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = path.join(
    parent,
    `.${path.basename(destination)}.partial-${randomUUID()}`,
  );
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    const result = await operation(stage);
    await assertEmptyDestination(destination);
    // Both directories share a filesystem; rename publishes the complete output atomically.
    await fs.rename(stage, destination);
    return result;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export function validateDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      throw new Error("SQLite integrity check failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("SQLite foreign key check failed");
  } finally {
    db.close();
  }
}

/** Check file references against the snapshot, not the still-changing live database. */
export async function validateDocumentReferences(database, documentDirectory) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (
      !db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_documents'",
        )
        .get()
    )
      return;
    const rows = db
      .prepare("SELECT file_key,size_bytes,sha256 FROM project_documents")
      .all();
    for (const row of rows) {
      const key = safeRelativePath(row.file_key);
      if (key.includes("/"))
        throw new Error("Document file key must be a single filename");
      const filename = path.join(documentDirectory, key);
      const stat = await regularFile(filename);
      if (
        stat.size !== row.size_bytes ||
        (await sha256(filename)) !== row.sha256
      ) {
        throw new Error(
          `Document bytes do not match the database record: ${key}`,
        );
      }
    }
  } finally {
    db.close();
  }
}

export async function backupToDirectory(sourceDatabase, destination) {
  const database = path.resolve(sourceDatabase),
    output = path.resolve(destination);
  await regularFile(database);
  const documents = path.join(path.dirname(database), "documents");
  if (output === documents || output.startsWith(documents + path.sep)) {
    throw new Error(
      "Backup output must be outside the live documents directory",
    );
  }
  return stageDirectory(output, async (stage) => {
    const snapshot = path.join(stage, "snapshot.sqlite");
    const source = new DatabaseSync(database, { readOnly: true });
    try {
      await backup(source, snapshot);
    } finally {
      source.close();
    }
    // Make the copied database self-contained; only the snapshot's journal mode changes.
    const copied = new DatabaseSync(snapshot);
    try {
      copied.exec("PRAGMA journal_mode=DELETE");
    } finally {
      copied.close();
    }
    await fs.chmod(snapshot, 0o600);
    validateDatabase(snapshot);
    const copiedDocuments = path.join(stage, "documents");
    await fs.mkdir(copiedDocuments, { mode: 0o700 });
    let files = [];
    try {
      const stat = await fs.lstat(documents);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Live documents path must be a regular directory");
      files = await listFiles(documents);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const relative of files) {
      const sourceFile = path.join(documents, relative),
        outputFile = path.join(copiedDocuments, relative);
      await regularFile(sourceFile);
      await fs.mkdir(path.dirname(outputFile), {
        recursive: true,
        mode: 0o700,
      });
      await fs.copyFile(sourceFile, outputFile);
      await fs.chmod(outputFile, 0o600);
    }
    await validateDocumentReferences(snapshot, copiedDocuments);
    const manifest = {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      created_at: new Date().toISOString(),
      database: await fileEntry(stage, "snapshot.sqlite"),
      documents: await Promise.all(
        files.map((relative) => fileEntry(stage, `documents/${relative}`)),
      ),
    };
    await fs.writeFile(
      path.join(stage, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return manifest;
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArguments(process.argv.slice(2), ["--out", "--db"]);
    if (!args["--out"])
      throw new Error(
        "Usage: node server/scripts/backup.mjs --out NEW_OR_EMPTY_DIRECTORY [--db DATABASE_FILE]",
      );
    const source = args["--db"] ?? process.env.DB_PATH ?? defaultDatabasePath;
    const manifest = await backupToDirectory(source, args["--out"]);
    console.log(
      `Backup complete: ${path.resolve(args["--out"])} (${manifest.documents.length} document files)`,
    );
  } catch (error) {
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
