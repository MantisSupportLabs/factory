import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const backupScript = path.resolve(here, "../scripts/backup.mjs");
const restoreScript = path.resolve(here, "../scripts/restore.mjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function command(script, args, status = 0, env = {}) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
    });
    assert.equal(status, 0, `Expected failure: ${result.stdout}`);
    return result;
  } catch (error) {
    if (error.code !== status) throw error;
    return { stdout: error.stdout, stderr: error.stderr };
  }
}
async function absent(filename) {
  await assert.rejects(fs.stat(filename), (error) => error.code === "ENOENT");
}

// Test the actual operator CLI against isolated SQLite/files; never load the application database.
test("host backup and restore recover database records and attachments atomically", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dirtworks-recovery-"));
  const live = path.join(root, "live"),
    source = path.join(live, "dirtworks.db");
  await fs.mkdir(path.join(live, "documents"), { recursive: true });
  const bytes = Buffer.from("Verified civil drawing\nRevision A\n");
  await fs.writeFile(path.join(live, "documents", "drawing-file"), bytes);
  const database = new DatabaseSync(source);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE tenants(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE jobsites(id INTEGER PRIMARY KEY,tenant_id INTEGER NOT NULL REFERENCES tenants(id),name TEXT NOT NULL);
    CREATE TABLE provider_credentials(id INTEGER PRIMARY KEY,tenant_id INTEGER REFERENCES tenants(id),ciphertext TEXT NOT NULL);
    CREATE TABLE project_documents(id INTEGER PRIMARY KEY,tenant_id INTEGER REFERENCES tenants(id),jobsite_id INTEGER REFERENCES jobsites(id),file_key TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL);
    INSERT INTO tenants VALUES (1,'Civil contractor'),(2,'Other tenant');
    INSERT INTO jobsites VALUES (1,1,'Storm drainage'),(2,2,'Other job');
    INSERT INTO provider_credentials VALUES (1,1,'encrypted-test-secret');`);
  database
    .prepare("INSERT INTO project_documents VALUES (1,1,1,?,?,?)")
    .run("drawing-file", bytes.length, digest(bytes));
  const archive = path.join(root, "archive");
  const restored = path.join(root, "restored");
  try {
    await t.test(
      "online SQLite backup includes uncheckpointed WAL records and adjacent document bytes",
      async () => {
        await command(backupScript, ["--out", archive], 0, { DB_PATH: source });
        const manifest = JSON.parse(
          await fs.readFile(path.join(archive, "manifest.json"), "utf8"),
        );
        assert.equal(manifest.format, "dirtworks-host-backup");
        assert.equal(manifest.version, 1);
        assert.ok(Number.isFinite(new Date(manifest.created_at).getTime()));
        assert.equal(manifest.database.path, "snapshot.sqlite");
        assert.equal(
          manifest.database.sha256,
          digest(await fs.readFile(path.join(archive, "snapshot.sqlite"))),
        );
        assert.deepEqual(
          manifest.documents.map((entry) => entry.path),
          ["documents/drawing-file"],
        );
        assert.deepEqual(
          await fs.readFile(path.join(archive, "documents", "drawing-file")),
          bytes,
        );
        if (process.platform !== "win32") {
          assert.equal((await fs.stat(archive)).mode & 0o777, 0o700);
          assert.equal(
            (await fs.stat(path.join(archive, "snapshot.sqlite"))).mode & 0o777,
            0o600,
          );
        }
      },
    );
    await t.test(
      "restore recovers multiple tenants, host credentials and file references into a new directory",
      async () => {
        await command(restoreScript, ["--from", archive, "--into", restored]);
        const restoredDb = new DatabaseSync(
          path.join(restored, "dirtworks.db"),
          { readOnly: true },
        );
        try {
          assert.deepEqual(
            restoredDb
              .prepare("SELECT name FROM jobsites ORDER BY id")
              .all()
              .map((row) => row.name),
            ["Storm drainage", "Other job"],
          );
          assert.equal(
            restoredDb
              .prepare("SELECT ciphertext FROM provider_credentials")
              .get().ciphertext,
            "encrypted-test-secret",
          );
          assert.equal(
            restoredDb.prepare("SELECT sha256 FROM project_documents").get()
              .sha256,
            digest(bytes),
          );
          assert.equal(
            restoredDb.prepare("PRAGMA integrity_check").get().integrity_check,
            "ok",
          );
          assert.deepEqual(
            restoredDb.prepare("PRAGMA foreign_key_check").all(),
            [],
          );
        } finally {
          restoredDb.close();
        }
        assert.deepEqual(
          await fs.readFile(path.join(restored, "documents", "drawing-file")),
          bytes,
        );
        assert.equal(
          database.prepare("SELECT COUNT(*) n FROM jobsites").get().n,
          2,
          "live database is untouched",
        );
      },
    );
    await t.test(
      "existing data is never replaced by backup or restore",
      async () => {
        const existing = path.join(root, "existing");
        await fs.mkdir(existing);
        await fs.writeFile(path.join(existing, "keep.txt"), "keep me");
        const backup = await command(
          backupScript,
          ["--db", source, "--out", existing],
          1,
        );
        assert.match(backup.stderr, /new or empty directory/);
        const restore = await command(
          restoreScript,
          ["--from", archive, "--into", existing],
          1,
        );
        assert.match(restore.stderr, /new or empty directory/);
        assert.deepEqual(await fs.readdir(existing), ["keep.txt"]);
        assert.equal(
          await fs.readFile(path.join(existing, "keep.txt"), "utf8"),
          "keep me",
        );
      },
    );
    await t.test(
      "tampered document or database archive bytes fail without a partial target",
      async () => {
        for (const file of ["documents/drawing-file", "snapshot.sqlite"]) {
          const changed = path.join(
            root,
            file.startsWith("documents") ? "tampered-file" : "tampered-db",
          );
          await fs.cp(archive, changed, { recursive: true });
          await fs.appendFile(path.join(changed, file), "tampered");
          const target = path.join(root, path.basename(changed) + "-target");
          const failure = await command(
            restoreScript,
            ["--from", changed, "--into", target],
            1,
          );
          assert.match(failure.stderr, /hash verification failed/);
          await absent(target);
        }
      },
    );
    await t.test(
      "rehashed broken references and invalid SQLite data are still rejected",
      async () => {
        const broken = path.join(root, "bad-foreign-key");
        await fs.cp(archive, broken, { recursive: true });
        const file = path.join(broken, "snapshot.sqlite"),
          db = new DatabaseSync(file);
        db.exec(
          "PRAGMA foreign_keys=OFF; INSERT INTO jobsites VALUES (3,999,'Broken reference')",
        );
        db.close();
        const manifest = JSON.parse(
          await fs.readFile(path.join(broken, "manifest.json"), "utf8"),
        );
        const content = await fs.readFile(file);
        manifest.database.sha256 = digest(content);
        manifest.database.size_bytes = content.length;
        await fs.writeFile(
          path.join(broken, "manifest.json"),
          JSON.stringify(manifest),
        );
        const target = path.join(root, "broken-target");
        const failure = await command(
          restoreScript,
          ["--from", broken, "--into", target],
          1,
        );
        assert.match(failure.stderr, /foreign key check failed/);
        await absent(target);
      },
    );
    await t.test(
      "a rehashed invalid SQLite file and document/database mismatch cannot be restored",
      async () => {
        const invalid = path.join(root, "invalid-sqlite");
        await fs.cp(archive, invalid, { recursive: true });
        const manifestFile = path.join(invalid, "manifest.json");
        const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
        const content = Buffer.from("This is not a SQLite database");
        await fs.writeFile(path.join(invalid, "snapshot.sqlite"), content);
        manifest.database.sha256 = digest(content);
        manifest.database.size_bytes = content.length;
        await fs.writeFile(manifestFile, JSON.stringify(manifest));
        const target = path.join(root, "invalid-sqlite-target");
        const failure = await command(
          restoreScript,
          ["--from", invalid, "--into", target],
          1,
        );
        assert.match(failure.stderr, /not a database|malformed|integrity/);
        await absent(target);

        const mismatch = path.join(root, "mismatched-reference");
        await fs.cp(archive, mismatch, { recursive: true });
        const mismatchManifestFile = path.join(mismatch, "manifest.json");
        const mismatchManifest = JSON.parse(
          await fs.readFile(mismatchManifestFile, "utf8"),
        );
        const changedBytes = Buffer.from(
          "Changed attachment with a recomputed archive hash",
        );
        await fs.writeFile(
          path.join(mismatch, "documents", "drawing-file"),
          changedBytes,
        );
        mismatchManifest.documents[0].size_bytes = changedBytes.length;
        mismatchManifest.documents[0].sha256 = digest(changedBytes);
        await fs.writeFile(
          mismatchManifestFile,
          JSON.stringify(mismatchManifest),
        );
        const mismatchTarget = path.join(root, "mismatched-target");
        const mismatchFailure = await command(
          restoreScript,
          ["--from", mismatch, "--into", mismatchTarget],
          1,
        );
        assert.match(
          mismatchFailure.stderr,
          /do not match the database record/,
        );
        await absent(mismatchTarget);
      },
    );
    await t.test(
      "manifest traversal, unsupported versions and incomplete file sets are rejected",
      async () => {
        const changed = path.join(root, "invalid-manifest");
        await fs.cp(archive, changed, { recursive: true });
        const file = path.join(changed, "manifest.json"),
          original = JSON.parse(await fs.readFile(file, "utf8"));
        for (const mutation of [
          (manifest) => {
            manifest.documents[0].path = "documents/../../escape";
          },
          (manifest) => {
            manifest.version = 999;
          },
          (manifest) => {
            manifest.documents = [];
          },
        ]) {
          const manifest = structuredClone(original);
          mutation(manifest);
          await fs.writeFile(file, JSON.stringify(manifest));
          const target = path.join(root, "invalid-target");
          await command(
            restoreScript,
            ["--from", changed, "--into", target],
            1,
          );
          await absent(target);
        }
      },
    );
    await t.test(
      "missing referenced documents abort backup and clean all staging output",
      async () => {
        await fs.rename(
          path.join(live, "documents", "drawing-file"),
          path.join(live, "documents", "temporarily-missing"),
        );
        const target = path.join(root, "incomplete-backup");
        await command(backupScript, ["--db", source, "--out", target], 1);
        await absent(target);
        await fs.rename(
          path.join(live, "documents", "temporarily-missing"),
          path.join(live, "documents", "drawing-file"),
        );
        assert.equal(
          (await fs.readdir(root)).filter((name) => name.includes(".partial-"))
            .length,
          0,
        );
      },
    );
  } finally {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
