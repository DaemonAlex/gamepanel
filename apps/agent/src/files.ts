import { createReadStream, createWriteStream } from "node:fs";
import { lchown, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// File access inside one server's folder. The game itself writes into this
// folder, so anything in it may be hostile, including symlinks that point
// outside. The agent runs as root, so every path is checked against where it
// really leads before it is read or written.

export class FileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface Entry {
  name: string;
  type: "file" | "dir" | "link";
  size: number;
  modified: string;
}

// Largest file the editor opens. Bigger files are download only.
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
// Largest single upload chunk the agent accepts.
export const MAX_CHUNK_BYTES = 100 * 1024 * 1024;
const UPLOAD_SUFFIX = ".gpupload";

// A relative path from the user, cleaned. "" is the server folder itself.
export function cleanRel(input: string): string {
  if (input.includes("\0") || input.includes("\\")) throw new FileError("bad path");
  const parts = input.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new FileError("bad path");
  return parts.join("/");
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export class ServerFiles {
  constructor(
    // The server folder. Must exist.
    private readonly root: string,
    // Where deleted things go, one folder per server.
    private readonly trash: string,
    private readonly uid: number,
  ) {}

  private async realRoot(): Promise<string> {
    return realpath(this.root);
  }

  // An existing path: follow everything and require the result to stay inside.
  private async existing(rel: string): Promise<string> {
    const root = await this.realRoot();
    let real: string;
    try {
      real = await realpath(join(root, cleanRel(rel)));
    } catch {
      throw new FileError("not found", 404);
    }
    if (!inside(root, real)) throw new FileError("path leaves the server folder", 403);
    return real;
  }

  // A path that may not exist yet: its folder must exist and be inside, and the
  // name itself must not be a symlink.
  private async target(rel: string): Promise<string> {
    const clean = cleanRel(rel);
    if (!clean) throw new FileError("a file name is needed");
    const parent = await this.existing(dirname(clean) === "." ? "" : dirname(clean));
    const path = join(parent, basename(clean));
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new FileError("will not write through a link", 403);
    } catch (err) {
      if (err instanceof FileError) throw err;
    }
    return path;
  }

  async list(rel: string): Promise<Entry[]> {
    const dir = await this.existing(rel);
    if (!(await stat(dir)).isDirectory()) throw new FileError("not a folder");
    const names = await readdir(dir);
    const out: Entry[] = [];
    for (const name of names) {
      if (name.endsWith(UPLOAD_SUFFIX)) continue;
      const s = await lstat(join(dir, name));
      out.push({
        name,
        type: s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : "file",
        size: s.isDirectory() ? 0 : s.size,
        modified: s.mtime.toISOString(),
      });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  async readText(rel: string): Promise<string> {
    const path = await this.existing(rel);
    const s = await stat(path);
    if (!s.isFile()) throw new FileError("not a file");
    if (s.size > MAX_EDIT_BYTES) throw new FileError("too big to edit here; download it instead", 413);
    const buf = await readFile(path);
    if (buf.includes(0)) throw new FileError("this is not a text file; download it instead", 415);
    return buf.toString("utf8");
  }

  async writeText(rel: string, text: string): Promise<void> {
    const path = await this.target(rel);
    await writeFile(path, text, { mode: 0o640 });
    await lchown(path, this.uid, this.uid);
  }

  async download(rel: string): Promise<{ stream: Readable; size: number; name: string }> {
    const path = await this.existing(rel);
    const s = await stat(path);
    if (!s.isFile()) throw new FileError("not a file");
    return { stream: createReadStream(path), size: s.size, name: basename(path) };
  }

  // Uploads come in pieces. offset 0 starts a fresh upload; each piece must
  // start where the last ended; the last piece (done) moves it into place.
  async uploadChunk(rel: string, offset: number, done: boolean, body: Readable): Promise<{ size: number }> {
    const path = await this.target(rel);
    const part = path + UPLOAD_SUFFIX;
    if (offset === 0) {
      await writeFile(part, "", { mode: 0o640 });
    } else {
      let have: number;
      try {
        have = (await lstat(part)).size;
      } catch {
        throw new FileError("upload was not started", 409);
      }
      if (have !== offset) throw new FileError(`upload is at ${have} bytes, not ${offset}`, 409);
    }
    // Count bytes inside the pipeline, so nothing flows before the file is ready.
    let seen = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > MAX_CHUNK_BYTES) done(new FileError("piece is too big", 413));
        else done(null, chunk);
      },
    });
    await pipeline(body, cap, createWriteStream(part, { flags: "a" }));
    const size = (await lstat(part)).size;
    if (done) {
      await rename(part, path);
      await lchown(path, this.uid, this.uid);
    }
    return { size };
  }

  async mkdir(rel: string): Promise<void> {
    const path = await this.target(rel);
    await mkdir(path, { mode: 0o750 });
    await lchown(path, this.uid, this.uid);
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = await this.existing(fromRel);
    if (from === (await this.realRoot())) throw new FileError("cannot rename the server folder");
    const to = await this.target(toRel);
    try {
      await lstat(to);
      throw new FileError("something with that name is already there", 409);
    } catch (err) {
      if (err instanceof FileError) throw err;
    }
    await rename(from, to);
  }

  // Deleted things go to the server's trash folder, so a mistake can be undone.
  async remove(rel: string): Promise<string> {
    const clean = cleanRel(rel);
    if (!clean) throw new FileError("cannot delete the server folder");
    // Remove the entry itself, not what a link points at.
    const parent = await this.existing(dirname(clean) === "." ? "" : dirname(clean));
    const path = join(parent, basename(clean));
    try {
      await lstat(path);
    } catch {
      throw new FileError("not found", 404);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(this.trash, stamp, relative(await this.realRoot(), path));
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await rename(path, dest);
    return dest;
  }
}
