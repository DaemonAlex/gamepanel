import { randomBytes } from "node:crypto";
import { chown, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import Docker from "dockerode";
import type { PowerAction, ServerId, ServerSpec, ServerState, ServerStatus } from "@gamepanel/shared";
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
  constructor(
    private readonly cfg: AgentConfig,
    private readonly docker: Docker = new Docker(),
  ) {}

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
      return { kind: layout.kind, worlds: layout.worlds, entries, backup, detected: await detect(target) };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
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
