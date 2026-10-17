import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { FileError, type ServerFiles } from "./files.js";

// Server logs and crash reports: list them, read one (unzipping old logs),
// and search. Only files under logs/ and crash-reports/ are reachable.

export interface LogFile {
  path: string;
  kind: "log" | "crash";
  bytes: number;
  modified: string;
}

const MAX_TEXT = 8 * 1024 * 1024;

export async function listLogs(files: ServerFiles): Promise<LogFile[]> {
  const out: LogFile[] = [];
  for (const [dir, kind] of [["logs", "log"], ["crash-reports", "crash"]] as const) {
    for (const e of await files.list(dir).catch(() => [])) {
      if (e.type !== "file" || !/\.(log|log\.gz|txt)$/.test(e.name)) continue;
      out.push({ path: `${dir}/${e.name}`, kind, bytes: e.size, modified: e.modified });
    }
  }
  // Newest first, with latest.log on top.
  return out.sort((a, b) => (a.path === "logs/latest.log" ? -1 : b.path === "logs/latest.log" ? 1 : b.modified.localeCompare(a.modified)));
}

export interface LogRead {
  path: string;
  // [line number, text]
  lines: [number, string][];
  total: number;
  matched: number;
  truncated: boolean;
}

export async function readLog(files: ServerFiles, path: string, opts: { search?: string; tail?: number } = {}): Promise<LogRead> {
  if (!/^(logs|crash-reports)\/[^/]+\.(log|log\.gz|txt)$/.test(path)) throw new FileError("not a log file");
  const real = await files.safeFile(path);
  let buf = await readFile(real);
  if (path.endsWith(".gz")) {
    try {
      buf = gunzipSync(buf, { maxOutputLength: MAX_TEXT });
    } catch {
      throw new FileError("this log is too big or damaged to open here; download it from Files", 413);
    }
  }
  if (buf.length > MAX_TEXT) buf = buf.subarray(buf.length - MAX_TEXT);
  const all = buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  const q = opts.search?.trim().toLowerCase();
  let picked: [number, string][] = all.map((t, i) => [i + 1, t]);
  if (q) picked = picked.filter(([, t]) => t.toLowerCase().includes(q));
  const matched = picked.length;
  const tail = Math.min(Math.max(opts.tail ?? 2000, 1), 5000);
  const truncated = picked.length > tail;
  return { path, lines: picked.slice(-tail), total: all.length, matched, truncated };
}
