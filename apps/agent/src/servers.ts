import { randomBytes } from "node:crypto";
import { chown, mkdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import Docker from "dockerode";
import { checkProperty } from "@gamepanel/shared";
import type { NodeInfo, PlayerAction, PlayersView, PowerAction, ServerId, ServerInfo, ServerSample, ServerSpec, ServerState, ServerStats, ServerStatus } from "@gamepanel/shared";
import { readFile } from "node:fs/promises";
import { Backups, LocalStore } from "./backups.js";
import { Quotas } from "./quota.js";
import { FileError, ServerFiles } from "./files.js";
import { folderBytes, listJars } from "./info.js";
import { commandFor, readPlayerFiles } from "./players.js";
import { readProperties, withoutSecrets, writeProperties } from "./properties-file.js";
import { copyFile } from "node:fs/promises";
import { parseList, parseMspt, parseTps, plain, RconPool } from "./rcon.js";
import { chownTree, detect, extractArchive, findLayout, fixServerPropertiesFile, type ArchiveFormat, type Detected } from "./import.js";
import type { AgentConfig } from "./config.js";
import { buildCreateOptions, containerName, imageFor, LABEL, MC_UID, rconPasswordFile, serverDir, STOP_TIMEOUT_S } from "./containers.js";

// The request is fine but the server is in the wrong state for it (HTTP 409).
export class ConflictError extends Error {}

export interface ImportResult {
  kind: "server" | "world";
  worlds: string[];
  entries: number;
  // Where the previous folder went, if there was one.
  backup: string | null;
  detected: Detected;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { statusCode?: number }).statusCode === 404;
}

function stateFrom(info: Docker.ContainerInspectInfo): ServerState {
  const s = info.State;
  if (s.Restarting) return "restarting";
  if (s.Running) return s.Health?.Status === "starting" ? "starting" : "running";
  if (s.Status === "created") return "created";
  return "stopped";
}

export class Servers {
  readonly backups: Backups;
  readonly quotas: Quotas;
  // One kept-open RCON connection per server (new connections spam the server log).
  private readonly rconPool = new RconPool();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly docker: Docker = new Docker(),
  ) {
    this.quotas = new Quotas(cfg.dataRoot.replace(/\/servers$/, ""));
    this.backups = new Backups(new LocalStore(`${cfg.backupRoot}/archives`), {
      serverDir: (id) => serverDir(cfg, id),
      dataRoot: cfg.dataRoot,
      preRestoreRoot: `${cfg.backupRoot}/pre-restore`,
      isRunning: async (id) => {
        const s = await this.status(id);
        return s.state === "running" || s.state === "starting" || s.state === "restarting";
      },
      rcon: (id, commands) => this.rconRun(id, commands),
      uid: MC_UID,
      afterRestore: (id) => this.quotas.reapply(id, serverDir(cfg, id)),
    });
  }

  // One bridge network for all game containers. Containers on it cannot reach
  // each other (icc off); the node firewall keeps them off private ranges.
  async ensureNetwork(): Promise<void> {
    const found = await this.docker.listNetworks({ filters: { name: [this.cfg.network] } });
    if (found.some((n) => n.Name === this.cfg.network)) return;
    await this.docker.createNetwork({
      Name: this.cfg.network,
      Driver: "bridge",
      Options: { "com.docker.network.bridge.enable_icc": "false", "com.docker.network.bridge.name": this.cfg.bridgeName },
      IPAM: { Config: [{ Subnet: this.cfg.subnet }] },
      Labels: { [LABEL]: "network" },
    });
  }

  // Create the server's folder and RCON secret the first time. Existing files are kept.
  private async prepareFiles(id: ServerId): Promise<void> {
    const dir = serverDir(this.cfg, id);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    await chown(dir, MC_UID, MC_UID);

    const secret = rconPasswordFile(this.cfg, id);
    await mkdir(dirname(secret), { recursive: true, mode: 0o711 });
    try {
      await writeFile(secret, randomBytes(24).toString("base64url"), { flag: "wx", mode: 0o400 });
      await chown(secret, MC_UID, MC_UID);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  private async pullIfMissing(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  // Create the container for a spec. A changed spec replaces the container;
  // the server's files in its folder are untouched.
  async apply(spec: ServerSpec): Promise<ServerStatus> {
    const current = await this.status(spec.id);
    if (current.state !== "missing" && current.state !== "created" && current.state !== "stopped") {
      throw new ConflictError("stop the server before changing it");
    }
    await this.ensureNetwork();
    await this.prepareFiles(spec.id);
    if (spec.diskGb) await this.quotas.set(spec.id, serverDir(this.cfg, spec.id), spec.diskGb);
    await this.pullIfMissing(imageFor(this.cfg, spec));
    await this.removeContainer(spec.id);
    await this.docker.createContainer(buildCreateOptions(this.cfg, spec));
    return this.status(spec.id);
  }

  async status(id: ServerId): Promise<ServerStatus> {
    try {
      const info = await this.docker.getContainer(containerName(id)).inspect();
      const status: ServerStatus = { id, state: stateFrom(info) };
      if (info.State.Running) status.startedAt = info.State.StartedAt;
      // A stopped container keeps its last health result, which would read as a fault.
      const health = info.State.Running ? info.State.Health?.Status : undefined;
      if (health === "starting" || health === "healthy" || health === "unhealthy") status.health = health;
      return status;
    } catch (err) {
      if (isNotFound(err)) return { id, state: "missing" };
      throw err;
    }
  }

  async power(id: ServerId, action: PowerAction): Promise<ServerStatus> {
    const c = this.docker.getContainer(containerName(id));
    try {
      if (action === "start") await c.start();
      if (action === "stop") await c.stop({ t: STOP_TIMEOUT_S });
      if (action === "restart") await c.restart({ t: STOP_TIMEOUT_S });
      if (action === "kill") await c.kill();
    } catch (err) {
      // 304 means it was already in that state, which is fine.
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
    return this.status(id);
  }

  // Removes the container only. The world and files stay in the server folder.
  async removeContainer(id: ServerId): Promise<void> {
    try {
      await this.docker.getContainer(containerName(id)).remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // Server output: the last `tail` lines, then new lines as they come.
  // The caller ends the stream to stop following.
  async logs(id: ServerId, tail = 500): Promise<Readable> {
    const c = this.docker.getContainer(containerName(id));
    const raw = (await c.logs({ follow: true, stdout: true, stderr: true, tail })) as unknown as Readable;
    const out = new PassThrough();
    // Without a TTY, Docker mixes stdout and stderr in one framed stream.
    this.docker.modem.demuxStream(raw, out, out);
    raw.on("end", () => out.end());
    out.on("close", () => raw.destroy());
    return out;
  }

  // Replace the server's folder with an uploaded world or server folder.
  // The old folder is moved to the backups folder, never deleted.
  async importArchive(id: ServerId, format: ArchiveFormat, source: Readable): Promise<ImportResult> {
    const current = await this.status(id);
    if (current.state !== "missing" && current.state !== "created" && current.state !== "stopped") {
      throw new ConflictError("stop the server before importing");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const staging = `${this.cfg.dataRoot}/.import-${id}-${stamp}`;
    try {
      const entries = await extractArchive(format, source, staging, `${staging}.upload`, this.cfg.importLimits);
      const layout = await findLayout(staging);
      const target = serverDir(this.cfg, id);

      let backup: string | null = null;
      if (await pathExists(target)) {
        await mkdir(this.cfg.backupRoot, { recursive: true, mode: 0o750 });
        backup = `${this.cfg.backupRoot}/${id}-pre-import-${stamp}`;
        await rename(target, backup);
      }

      if (layout.kind === "server") {
        await rename(layout.root, target);
      } else {
        await mkdir(target, { recursive: true, mode: 0o750 });
        await rename(layout.root, `${target}/world`);
      }
      await fixServerPropertiesFile(target);
      await chownTree(target, MC_UID, MC_UID);
      await this.quotas.reapply(id, target);
      return { kind: layout.kind, worlds: layout.worlds, entries, backup, detected: await detect(target) };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  // File access for one server's folder. Deletes go to backups/trash/<id>.
  files(id: ServerId): ServerFiles {
    return new ServerFiles(serverDir(this.cfg, id), `${this.cfg.backupRoot}/trash/${id}`, MC_UID);
  }

  // Everything the Overview shows. Slow parts (folder sizes, jars) are cached.
  async info(id: ServerId): Promise<ServerInfo> {
    const files = this.files(id);
    const dir = serverDir(this.cfg, id);
    const props = readProperties(await files.readText("server.properties").catch(() => ""));

    let build: string | null = null;
    try {
      build = (JSON.parse(await files.readText("version_history.json")) as { currentVersion?: string }).currentVersion ?? null;
    } catch {
      // Only Paper and Purpur write this file.
    }

    const top = await files.list("").catch(() => []);
    const worlds: ServerInfo["worlds"] = [];
    for (const e of top) {
      if (e.type !== "dir") continue;
      const isWorld = await files.safeFile(`${e.name}/level.dat`).then(() => true).catch(() => false);
      if (isWorld) worlds.push({ name: e.name, bytes: await folderBytes(`${dir}/${e.name}`) });
    }

    let image: string | null = null;
    let restartCount = 0;
    let lastExit: ServerInfo["lastExit"] = null;
    let running = false;
    let ip: string | null = null;
    try {
      const c = await this.docker.getContainer(containerName(id)).inspect();
      image = c.Config.Image;
      restartCount = c.RestartCount ?? 0;
      running = c.State.Running;
      if (c.State.FinishedAt && !c.State.FinishedAt.startsWith("0001")) {
        lastExit = { code: c.State.ExitCode, at: c.State.FinishedAt, oomKilled: c.State.OOMKilled };
      }
      ip = c.NetworkSettings.Networks[this.cfg.network]?.IPAddress || null;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    return {
      properties: withoutSecrets(props),
      build,
      java: image?.match(/java(\d+)/)?.[1] ?? null,
      image,
      restartCount,
      lastExit,
      worlds: worlds.sort((a, b) => b.bytes - a.bytes),
      diskBytes: await folderBytes(dir),
      plugins: await listJars(files, "plugins"),
      mods: await listJars(files, "mods"),
      live: running && ip ? await this.live(id, ip) : null,
    };
  }

  // A cheap sample for the panel's 30-second poll: Docker numbers, one RCON
  // round trip, and the cached folder size.
  async sample(id: ServerId): Promise<ServerSample> {
    const c = await this.docker.getContainer(containerName(id)).inspect();
    const stats = await this.stats(id);
    const ip = c.NetworkSettings.Networks[this.cfg.network]?.IPAddress || null;
    const live = c.State.Running && ip ? await this.live(id, ip) : null;
    return {
      cpuPercent: stats.cpuPercent,
      memoryBytes: stats.memoryBytes,
      memoryLimitBytes: stats.memoryLimitBytes,
      players: live?.online ?? stats.players?.online ?? null,
      tps: live?.tps?.[0] ?? null,
      msptAvg: live?.msptAvg ?? null,
      diskBytes: await folderBytes(serverDir(this.cfg, id)),
      restartCount: c.RestartCount ?? 0,
    };
  }

  async properties(id: ServerId): Promise<Record<string, string>> {
    return withoutSecrets(readProperties(await this.files(id).readText("server.properties").catch(() => "")));
  }

  // Save settings. Every change is checked against the allowed fields; the old
  // file is copied to backups/settings/<id>/ first. Takes effect on restart.
  async setProperties(id: ServerId, changes: Record<string, string>): Promise<{ backup: string; changed: string[] }> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(changes)) {
      const r = checkProperty(k, v);
      if (!r.ok) throw new FileError(r.error);
      clean[k] = r.value;
    }
    const files = this.files(id);
    const current = await files.readText("server.properties").catch(() => "");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = `${this.cfg.backupRoot}/settings/${id}`;
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const backup = `${dir}/server.properties.${stamp}`;
    if (current) {
      await copyFile(await files.safeFile("server.properties"), backup);
    }
    await files.writeText("server.properties", writeProperties(current, clean));
    return { backup, changed: Object.keys(clean) };
  }

  // Run commands over RCON on a running server and return the plain answers.
  private async rconRun(id: ServerId, commands: string[]): Promise<string[]> {
    const c = await this.docker.getContainer(containerName(id)).inspect();
    const ip = c.NetworkSettings.Networks[this.cfg.network]?.IPAddress;
    if (!c.State.Running || !ip) throw new ConflictError("the server is not running");
    const password = (await readFile(rconPasswordFile(this.cfg, id), "utf8")).trim();
    return (await this.rconPool.run(id, ip, 25575, password, commands)).map(plain);
  }

  async players(id: ServerId): Promise<PlayersView> {
    const files = this.files(id);
    const fromFiles = await readPlayerFiles(files);
    const whitelistOn = (await files.readText("server.properties").catch(() => "")).match(/^white-list\s*=\s*true/m) !== null;
    let running = false;
    let online: PlayersView["online"] = [];
    let max = 0;
    try {
      const [list] = await this.rconRun(id, ["minecraft:list uuids"]);
      const parsed = parseList(list ?? "");
      running = true;
      online = parsed?.players ?? [];
      max = parsed?.max ?? 0;
    } catch {
      // Stopped, or not answering yet: the lists from files still show.
    }
    return { running, online, max, whitelistOn, ...fromFiles };
  }

  // One player action; returns what the server answered.
  async playerAction(id: ServerId, action: PlayerAction): Promise<string> {
    const [answer] = await this.rconRun(id, [commandFor(action)]);
    return answer ?? "";
  }

  async setWhitelist(id: ServerId, on: boolean): Promise<string> {
    const [answer] = await this.rconRun(id, [on ? "minecraft:whitelist on" : "minecraft:whitelist off"]);
    return answer ?? "";
  }

  // TPS, tick time and the player list over RCON. Missing commands just come back null.
  private async live(id: ServerId, ip: string): Promise<ServerInfo["live"]> {
    try {
      const password = (await readFile(rconPasswordFile(this.cfg, id), "utf8")).trim();
      // minecraft:list skips plugins (like Essentials) that replace "list".
      const [tps, mspt, list] = await this.rconPool.run(id, ip, 25575, password, ["tps", "mspt", "minecraft:list uuids"]);
      const players = parseList(list ?? "");
      return {
        tps: parseTps(tps ?? ""),
        msptAvg: parseMspt(mspt ?? ""),
        players: players?.players ?? [],
        online: players?.online ?? 0,
        max: players?.max ?? 0,
      };
    } catch {
      return null;
    }
  }

  async setDisk(id: ServerId, gb: number) {
    await this.quotas.set(id, serverDir(this.cfg, id), gb);
    return this.quotas.usage(id);
  }

  // Every game server container on this node, by label.
  async list(): Promise<ServerStatus[]> {
    const found = await this.docker.listContainers({ all: true, filters: { label: [LABEL] } });
    const ids = found.map((c) => c.Labels[LABEL]).filter((id): id is string => !!id && id !== "network");
    return Promise.all(ids.map((id) => this.status(id)));
  }

  async nodeInfo(): Promise<NodeInfo> {
    const fs = await statfs(this.cfg.dataRoot);
    const found = await this.docker.listContainers({ all: true, filters: { label: [LABEL] } });
    let allocated = 0;
    for (const c of found) {
      const info = await this.docker.getContainer(c.Id).inspect();
      allocated += info.HostConfig.Memory ?? 0;
    }
    return {
      memoryBytes: totalmem(),
      cpus: cpus().length,
      disk: { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize },
      servers: { total: found.length, running: found.filter((c) => c.State === "running").length, allocatedMemoryBytes: allocated },
    };
  }

  // CPU and memory from Docker, players from a status ping inside the container.
  async stats(id: ServerId): Promise<ServerStats> {
    const c = this.docker.getContainer(containerName(id));
    const s = (await c.stats({ stream: false })) as Docker.ContainerStats;
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
    const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
    const online = s.cpu_stats.online_cpus ?? 1;
    const cache = (s.memory_stats.stats as Record<string, number> | undefined)?.inactive_file ?? 0;

    let players: ServerStats["players"] = null;
    let version: string | null = null;
    try {
      const out = await this.execCapture(id, ["mc-monitor", "status", "--json", "--timeout", "3s"]);
      const ping = JSON.parse(out) as { server_info?: { version?: { name?: string }; players?: { online?: number; max?: number; Sample?: { name: string }[] | null } } };
      const p = ping.server_info?.players;
      if (p) players = { online: p.online ?? 0, max: p.max ?? 0, names: (p.Sample ?? []).map((x) => x.name) };
      version = ping.server_info?.version?.name ?? null;
    } catch {
      // Still starting, or not answering pings.
    }

    return {
      cpuPercent: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * online * 1000) / 10 : 0,
      memoryBytes: Math.max(0, (s.memory_stats.usage ?? 0) - cache),
      memoryLimitBytes: s.memory_stats.limit ?? 0,
      players,
      version,
    };
  }

  // Run a command in the container as the game user and return what it printed.
  private async execCapture(id: ServerId, cmd: string[]): Promise<string> {
    const c = this.docker.getContainer(containerName(id));
    const exec = await c.exec({ Cmd: cmd, User: String(MC_UID), AttachStdout: true, AttachStderr: true });
    const raw = await exec.start({});
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (b: Buffer) => chunks.push(b));
    this.docker.modem.demuxStream(raw, out, new PassThrough());
    await new Promise<void>((resolve, reject) => {
      raw.on("end", resolve);
      raw.on("error", reject);
    });
    const result = await exec.inspect();
    if (result.ExitCode !== 0) throw new Error(`exit ${result.ExitCode}`);
    return Buffer.concat(chunks).toString("utf8");
  }

  // One console command, given to the server as typed. The command is passed as
  // an argument (no shell), so it cannot run anything else in the container.
  async sendCommand(id: ServerId, cmd: string): Promise<void> {
    const c = this.docker.getContainer(containerName(id));
    const exec = await c.exec({ Cmd: ["mc-send-to-console", cmd], User: String(MC_UID), AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({});
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
      stream.resume();
    });
    const result = await exec.inspect();
    if (result.ExitCode !== 0) throw new Error(`console command failed (exit ${result.ExitCode})`);
  }
}
