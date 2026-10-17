import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import type { BackupEntry, BackupJob } from "@gamepanel/shared";
import { backupNameSchema } from "@gamepanel/shared";
import { chownTree, extractArchive, findLayout, fixServerPropertiesFile } from "./import.js";
import { folderBytes } from "./info.js";

// Where backups live. Local disk now; an off-node store (Cloudflare R2 or
// similar) can implement the same four calls later.
export interface BackupStore {
  writer(serverId: string, name: string): Promise<{ stream: Writable; commit: () => Promise<void>; abort: () => Promise<void> }>;
  list(serverId: string): Promise<BackupEntry[]>;
  reader(serverId: string, name: string): Promise<{ stream: Readable; bytes: number }>;
  remove(serverId: string, name: string): Promise<void>;
}

export class LocalStore implements BackupStore {
  constructor(private readonly root: string) {}

  private dir(serverId: string) {
    return join(this.root, serverId);
  }

  async writer(serverId: string, name: string) {
    await mkdir(this.dir(serverId), { recursive: true, mode: 0o750 });
    const final = join(this.dir(serverId), backupNameSchema.parse(name));
    const part = `${final}.part`;
    const stream = createWriteStream(part, { mode: 0o640 });
    return {
      stream,
      commit: () => rename(part, final),
      abort: () => rm(part, { force: true }),
    };
  }

  async list(serverId: string): Promise<BackupEntry[]> {
    const names = await readdir(this.dir(serverId)).catch(() => [] as string[]);
    const out: BackupEntry[] = [];
    for (const name of names) {
      if (!backupNameSchema.safeParse(name).success) continue;
      const s = await stat(join(this.dir(serverId), name));
      out.push({ name, bytes: s.size, createdAt: s.mtime.toISOString(), reason: name.match(/Z-([a-z-]+)\.tar\.gz$/)?.[1] ?? "manual" });
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }

  async reader(serverId: string, name: string) {
    const path = join(this.dir(serverId), backupNameSchema.parse(name));
    const s = await stat(path).catch(() => null);
    if (!s) throw new BackupError("backup not found", 404);
    return { stream: createReadStream(path), bytes: s.size };
  }

  async remove(serverId: string, name: string) {
    await rm(join(this.dir(serverId), backupNameSchema.parse(name)), { force: true });
  }
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

// Things the image downloads again on start, and logs: left out to keep backups small.
const SKIP_TOP = new Set(["cache", "libraries", "versions", "logs", ".cache"]);

export function backupName(reason: string, at = new Date()): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${reason}.tar.gz`;
}

export interface BackupDeps {
  serverDir: (id: string) => string;
  // Data root for restore staging (same disk as the server folders).
  dataRoot: string;
  // Where a replaced server folder is moved before a restore. Never deleted.
  preRestoreRoot: string;
  isRunning: (id: string) => Promise<boolean>;
  // Console commands over RCON; only called while the server runs.
  rcon: (id: string, commands: string[]) => Promise<string[]>;
  uid: number;
}

export class Backups {
  private jobs = new Map<string, BackupJob>();

  constructor(
    private readonly store: BackupStore,
    private readonly deps: BackupDeps,
  ) {}

  list(serverId: string) {
    return this.store.list(serverId);
  }

  jobsFor(serverId: string): BackupJob[] {
    return [...this.jobs.values()].filter((j) => j.serverId === serverId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private busy(serverId: string) {
    return [...this.jobs.values()].some((j) => j.serverId === serverId && j.state === "running");
  }

  private newJob(serverId: string, kind: BackupJob["kind"]): BackupJob {
    if (this.busy(serverId)) throw new BackupError("a backup or restore is already running for this server");
    const job: BackupJob = { id: randomUUID(), serverId, kind, state: "running", startedAt: new Date().toISOString(), bytes: 0 };
    this.jobs.set(job.id, job);
    // Keep only the last 20 finished jobs per server in memory.
    const old = this.jobsFor(serverId).filter((j) => j.state !== "running").slice(20);
    for (const j of old) this.jobs.delete(j.id);
    return job;
  }

  // Starts a backup and returns at once; progress shows in the job.
  async start(serverId: string, reason = "manual", keep?: number): Promise<BackupJob> {
    const dir = this.deps.serverDir(serverId);
    const fs = await statfs(dir);
    const need = await folderBytes(dir, 0);
    if (fs.bavail * fs.bsize < need * 1.1) throw new BackupError("not enough free disk on the node for a backup");
    const job = this.newJob(serverId, "backup");
    void this.runBackup(job, dir, reason).then(async () => {
      // Trim to the newest N only after a good backup, so a failed one never costs an old one.
      if (job.state === "done" && keep) await this.prune(serverId, keep).catch(() => {});
    });
    return job;
  }

  private async runBackup(job: BackupJob, dir: string, reason: string) {
    const running = await this.deps.isRunning(job.serverId);
    const name = backupName(reason);
    const out = await this.store.writer(job.serverId, name);
    try {
      // Flush the world to disk and hold saving while the archive is made.
      if (running) await this.deps.rcon(job.serverId, ["save-off", "save-all flush"]);
      const counter = new Transform({
        transform(chunk: Buffer, _e, done) {
          job.bytes += chunk.length;
          done(null, chunk);
        },
      });
      const pack = tar.c(
        {
          gzip: true,
          cwd: dir,
          portable: true,
          filter: (path, s) => {
            const top = path.replace(/^\.\//, "").split("/")[0] ?? "";
            if (SKIP_TOP.has(top) || path.endsWith(".gpupload")) return false;
            // Only plain files and folders; links are never followed or stored.
            return "isFile" in s ? s.isFile() || s.isDirectory() : true;
          },
        },
        ["."],
      );
      await pipeline(pack, counter, out.stream);
      await out.commit();
      job.backup = name;
      job.state = "done";
    } catch (err) {
      await out.abort();
      job.state = "failed";
      job.error = (err as Error).message;
    } finally {
      if (running) await this.deps.rcon(job.serverId, ["save-on"]).catch(() => {});
      job.finishedAt = new Date().toISOString();
    }
  }

  // Replace the server folder with a backup. The server must be stopped; the
  // folder it had is moved aside (never deleted).
  async restore(serverId: string, name: string): Promise<BackupJob> {
    if (await this.deps.isRunning(serverId)) throw new BackupError("stop the server before restoring");
    const src = await this.store.reader(serverId, name);
    const job = this.newJob(serverId, "restore");
    job.bytes = src.bytes;
    job.backup = name;
    void this.runRestore(job, src.stream);
    return job;
  }

  private async runRestore(job: BackupJob, source: Readable) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const staging = join(this.deps.dataRoot, `.restore-${job.serverId}-${stamp}`);
    const target = this.deps.serverDir(job.serverId);
    try {
      await extractArchive("tar.gz", source, staging, `${staging}.upload`, { maxBytes: 500 * 2 ** 30, maxEntries: 2_000_000 });
      const layout = await findLayout(staging);
      await mkdir(this.deps.preRestoreRoot, { recursive: true, mode: 0o750 });
      const aside = join(this.deps.preRestoreRoot, `${job.serverId}-${stamp}`);
      if (await stat(target).then(() => true, () => false)) await rename(target, aside);
      await rename(layout.root, target);
      await fixServerPropertiesFile(target);
      await chownTree(target, this.deps.uid, this.deps.uid);
      job.state = "done";
    } catch (err) {
      job.state = "failed";
      job.error = (err as Error).message;
    } finally {
      await rm(staging, { recursive: true, force: true });
      job.finishedAt = new Date().toISOString();
    }
  }

  async download(serverId: string, name: string) {
    return this.store.reader(serverId, name);
  }

  async remove(serverId: string, name: string) {
    await this.store.remove(serverId, name);
  }

  // Keep the newest N; older ones are removed. Returns what was removed.
  async prune(serverId: string, keep: number): Promise<string[]> {
    const all = await this.store.list(serverId);
    const gone = all.slice(Math.max(keep, 1)).map((b) => b.name);
    for (const n of gone) await this.store.remove(serverId, n);
    return gone;
  }
}
