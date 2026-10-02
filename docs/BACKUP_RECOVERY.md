# Host backup and recovery

These commands run on the server host. They back up the **entire database**, including every tenant, authentication records, sessions, and encrypted provider credentials, together with the adjacent `documents/` folder. They are not available through the tenant API or business-data export.

Run the examples from the repository root with Node.js 24 or later. The tools never initialize application tables, run seed data, or overwrite the source database. Backup uses the Node `node:sqlite` backup API rather than copying a live database file.

## Create a recovery archive

For the default database at `server/data/dirtworks.db`:

```bash
node server/scripts/backup.mjs --out /srv/dirtworks-backups/2026-10-02
```

For a deployed database:

```bash
DB_PATH=/srv/dirtworks/data/dirtworks.db node server/scripts/backup.mjs --out /srv/dirtworks-backups/2026-10-02
```

An explicit `--db` takes precedence over `DB_PATH`:

```bash
node server/scripts/backup.mjs --db /srv/dirtworks/data/dirtworks.db --out /srv/dirtworks-backups/2026-10-02
```

The output directory must be new or empty. Choose a different archive directory for each run. The tool publishes these files together only after validation succeeds:

```text
2026-10-02/
  snapshot.sqlite
  documents/
  manifest.json
```

`manifest.json` records the archive format/version, creation time in UTC, byte sizes, and SHA256 hashes for the snapshot and each document. The database snapshot includes committed WAL records and is converted to a self-contained journal mode; the archive does not depend on the live `-wal` or `-shm` files. The live database's journal mode is unchanged.

The server can remain online during backup. Uploaded document revisions are immutable, and backup verifies every document reference against the copied database's stored size and hash. A missing or inconsistent attachment fails the archive. Concurrent failed uploads or host file changes may also cause a backup to fail; rerun into a fresh directory after addressing the cause. Do not manually delete or edit stored documents.

The CLI stages its work in a private sibling directory. A validation or copy failure removes staging data and leaves the requested output absent, or leaves an existing empty output unchanged. Normal successful output prints `Backup complete` and exits with status 0; failure exits with status 1.

## Restore into an isolated directory

First stop the application server with its normal service stop command, or `Ctrl+C` for a development server, before switching it to a restored database. The restore tool writes an isolated directory; it cannot verify whether a separate server process is stopped.

```bash
node server/scripts/restore.mjs --from /srv/dirtworks-backups/2026-10-02 --into /srv/dirtworks-recovery/2026-10-02
```

`--from` and `--into` are both required. The destination must be new or empty and outside the archive. Existing files are refused. There is no overwrite or force option. Restore first verifies the manifest, all file sizes/hashes, SQLite `integrity_check`, SQLite `foreign_key_check`, and the attachment references. It repeats database and attachment checks on the staged copy before publishing:

```text
2026-10-02/
  dirtworks.db
  documents/
  manifest.json
```

The restored database is named `dirtworks.db`; the archived database is named `snapshot.sqlite`. Keep restored `documents/` next to `dirtworks.db`, since the application derives its document path from `DB_PATH`.

After a successful restore, start the built application from the repository root using the recovered path:

```bash
DB_PATH=/srv/dirtworks-recovery/2026-10-02/dirtworks.db npm run start --workspace=server
```

Supply the same deployment environment and `CREDENTIALS_KEY` used to encrypt the archived provider credentials. Encryption keys and other environment configuration are **not** saved in the archive. Application startup runs its normal additive migrations against the recovered copy.

Before directing users to the recovered instance, check the expected jobs, approved reports, financial records, and a downloaded attachment. Retain the previous live database and its adjacent files until recovery is accepted. Switching `DB_PATH` leaves that previous database available for rollback; these tools never replace it.

## Protect and verify archives

Only trusted host operators should run these commands or read their output. Created directories use permissions `0700` and files use `0600` on systems supporting POSIX permissions. Protect the parent storage and copies with equivalent access restrictions and encryption at rest; the archive itself is not encrypted. SHA256 verifies content against the manifest but is not a signature, so keep the manifest and archive in trusted storage.

A tenant JSON business export is useful for review and transfer of business records. It omits attachment bytes, authentication records, and credentials and cannot serve as a host restore archive.

Copy archives to separate protected storage and rehearse restore regularly into a new directory. The automated recovery checks use isolated temporary SQLite databases and files:

```bash
node --test server/tests/recovery.test.mjs
```

They prove recovery of committed WAL records, multiple tenants, credential records, and attachment bytes; refusal of existing destinations; corruption and manifest rejection; foreign-key validation; and removal of partial output on failure. A passing test does not replace an operator's restore rehearsal against the deployed environment and preserved encryption key.
