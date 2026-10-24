import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

// Disk caps per server folder, with XFS project quotas on the node's data disk.
// Each server gets a fixed project number, kept in a small file on that disk.

const run = promisify(execFile);

export class Quotas {
  constructor(
    // Mount point of the XFS data disk, e.g. /srv/gamepanel.
    private readonly mount: string,
    private readonly registry = `${mount}/quota-ids.json`,
  ) {}

  private async ids(): Promise<Record<string, { id: number; gb: number }>> {
    try {
      return JSON.parse(await readFile(this.registry, "utf8")) as Record<string, { id: number; gb: number }>;
    } catch {
      return {};
    }
  }

  // Tie the folder to the server's project (assigned once, never reused) and set the hard limit.
  async set(serverId: string, dir: string, gb: number): Promise<void> {
    if (!Number.isInteger(gb) || gb < 1) throw new Error("disk limit must be a whole number of GB");
    const all = await this.ids();
    const id = all[serverId]?.id ?? Math.max(1000, ...Object.values(all).map((x) => x.id)) + 1;
    all[serverId] = { id, gb };
    await writeFile(this.registry, JSON.stringify(all, null, 2), { mode: 0o600 });
    await run("xfs_quota", ["-x", "-c", `project -s -p ${dir} ${id}`, this.mount]);
    await run("xfs_quota", ["-x", "-c", `limit -p bhard=${gb}g ${id}`, this.mount]);
  }

  // A folder that was swapped in (restore, import) needs tagging again.
  async reapply(serverId: string, dir: string): Promise<void> {
    const q = (await this.ids())[serverId];
    if (q) await this.set(serverId, dir, q.gb);
  }

  // Bytes used and the hard limit, from the quota report.
  async usage(serverId: string): Promise<{ usedBytes: number; limitBytes: number } | null> {
    const id = (await this.ids())[serverId]?.id;
    if (!id) return null;
    const { stdout } = await run("xfs_quota", ["-x", "-c", "report -p -b -N", this.mount]);
    const line = stdout.split("\n").find((l) => l.trim().startsWith(`#${id} `));
    if (!line) return null;
    const [, used, , hard] = line.trim().split(/\s+/);
    return { usedBytes: Number(used) * 1024, limitBytes: Number(hard) * 1024 };
  }
}
