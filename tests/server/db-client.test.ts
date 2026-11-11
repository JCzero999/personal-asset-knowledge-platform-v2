import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/server/db/client";
import { sql } from "drizzle-orm";

/**
 * 文件库冒烟测试：确认连接参数（WAL / 外键 / busy_timeout）真的生效，
 * 且迁移能在真实文件上跑完。只在系统临时目录里建库，不碰 data/。
 */

const dir = mkdtempSync(path.join(tmpdir(), "pakp-db-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase (file)", () => {
  it("设置 PRAGMA 并创建全部表", () => {
    const handle = openDatabase({ file: path.join(dir, "test.db") });

    const pragma = (name: string) => handle.sqlite.pragma(name, { simple: true });

    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("busy_timeout")).toBe(5000);

    const tables = handle.sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining(["objects", "content_refs", "library_events", "sync_jobs"]),
    );

    handle.close();
  });

  it("迁移是幂等的：重复打开同一文件不会重复执行", () => {
    const file = path.join(dir, "twice.db");
    const first = openDatabase({ file });
    first.close();

    const second = openDatabase({ file });
    const row = second.db.get<{ count: number }>(sql`select count(*) as count from objects`);

    expect(row).toEqual({ count: 0 });
    second.close();
  });
});
