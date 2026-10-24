import { describe, expect, it } from "vitest";
import { buildDelete, buildExists, buildUpdate, dbNameFor, formatCell, isBinaryType, linkBridge, linkNetwork, quoteId, readOnlyUser } from "./db-sql.js";

describe("database names", () => {
  it("prefixes the server id", () => {
    expect(dbNameFor("pw", "coreprotect")).toBe("pw_coreprotect");
    expect(dbNameFor("my-server", "luckperms")).toBe("my_server_luckperms");
    expect(readOnlyUser("pw_coreprotect")).toBe("pw_coreprotect_r");
  });

  it("refuses names MariaDB would not take", () => {
    expect(() => dbNameFor("a".repeat(32), "b".repeat(40))).toThrow(/too long/);
  });

  it("gives each server its own link with a short bridge name", () => {
    expect(linkNetwork("pw")).toBe("gp-db-pw");
    expect(linkBridge("pw")).toMatch(/^gpdb[0-9a-f]{10}$/);
    expect(linkBridge("pw").length).toBeLessThanOrEqual(15);
    expect(linkBridge("pw")).not.toBe(linkBridge("pw2"));
  });
});

describe("quoting", () => {
  it("wraps names in backticks and doubles any inside", () => {
    expect(quoteId("co_block")).toBe("`co_block`");
    expect(quoteId("we`ird")).toBe("`we``ird`");
    expect(() => quoteId("")).toThrow();
  });
});

describe("cells", () => {
  it("shows values as text and binary as short hex", () => {
    expect(formatCell(null)).toBeNull();
    expect(formatCell(42)).toBe("42");
    expect(formatCell("x")).toBe("x");
    expect(formatCell(Buffer.from([0xde, 0xad]))).toBe("0xdead");
    expect(formatCell(Buffer.alloc(100))).toMatch(/^0x0{128}\.\.\. \(100 bytes\)$/);
    expect(isBinaryType("BLOB")).toBe(true);
    expect(isBinaryType("varchar")).toBe(false);
  });
});

describe("row edits", () => {
  it("updates exactly one row by its whole primary key", () => {
    const q = buildUpdate("co_user", ["id"], new Set(), { id: "7" }, { user: "Eric", uuid: null });
    expect(q.sql).toBe("UPDATE `co_user` SET `user` = ?, `uuid` = ? WHERE `id` <=> ? LIMIT 1");
    expect(q.params).toEqual(["Eric", null, "7"]);
  });

  it("checks a row exists by its key", () => {
    expect(buildExists("co_user", ["id"], { id: "7" })).toEqual({ sql: "SELECT 1 FROM `co_user` WHERE `id` <=> ? LIMIT 1", params: ["7"] });
  });

  it("handles a key made of several columns", () => {
    const q = buildDelete("t", ["a", "b"], { b: "2", a: "1" });
    expect(q.sql).toBe("DELETE FROM `t` WHERE `a` <=> ? AND `b` <=> ? LIMIT 1");
    expect(q.params).toEqual(["1", "2"]);
  });

  it.each([
    [[], { id: "1" }, /no primary key/],
    [["id"], {}, /whole primary key/],
    [["id"], { id: "1", other: "2" }, /whole primary key/],
    [["a", "b"], { a: "1" }, /whole primary key/],
  ])("refuses a row named badly (key %j)", (pk, key, msg) => {
    expect(() => buildDelete("t", pk as string[], key as Record<string, string>)).toThrow(msg);
  });

  it("will not write binary columns or an empty change", () => {
    expect(() => buildUpdate("co_block", ["rowid"], new Set(["meta"]), { rowid: "1" }, { meta: "x" })).toThrow(/binary/);
    expect(() => buildUpdate("t", ["id"], new Set(), { id: "1" }, {})).toThrow(/nothing to change/);
  });
});
