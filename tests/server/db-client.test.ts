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

  it("数据库兜底约束：外键、非空标识与取值域", () => {
    const handle = openDatabase({ file: path.join(dir, "constraints.db") });
    const at = "2026-11-11T00:00:00.000Z";

    expect(() =>
      handle.sqlite
        .prepare(
          `insert into library_events
             (id, object_id, from_library, to_library, reason, actor_sub, created_at)
           values ('evt_1', 'missing_object', 'external', 'internal', 'r', 'u', ?)`,
        )
        .run(at),
    ).toThrow(/FOREIGN KEY constraint failed/i);

    expect(() =>
      handle.sqlite
        .prepare(
          `insert into sync_jobs
             (id, owner_type, owner_id, content_ref_id, action, state, attempts,
              available_at, created_at, updated_at)
           values ('job_1', 'work', 'owner', 'missing_ref', 'upsert', 'pending', 0,
                   ?, ?, ?)`,
        )
        .run(at, at, at),
    ).toThrow(/FOREIGN KEY constraint failed/i);

    expect(() =>
      handle.sqlite
        .prepare(
          `insert into content_refs
             (id, owner_type, owner_id, provider, dataset_id, document_id, content_key,
              role, created_at, updated_at)
           values ('ref_1', 'work', 'owner', 'ragflow', '', 'doc', 'key', 'primary', ?, ?)`,
        )
        .run(at, at),
    ).toThrow(/CHECK constraint failed/i);

    handle.sqlite
      .prepare(
        `insert into objects
           (id, type, title, library, source, origin, priority, owner_sub,
            created_at, updated_at)
         values ('obj_1', 'asset', '资产', 'external', 'handwritten', 'self', 'medium', 'u', ?, ?)`,
      )
      .run(at, at);

    expect(() =>
      handle.sqlite
        .prepare(
          `insert into library_events
             (id, object_id, from_library, to_library, reason, actor_sub, created_at)
           values ('evt_same', 'obj_1', 'internal', 'internal', 'r', 'u', ?)`,
        )
        .run(at),
    ).toThrow(/CHECK constraint failed/i);

    handle.close();
  });

  it("迁移目录不存在时给出可读错误", () => {
    expect(() =>
      openDatabase({
        file: ":memory:",
        migrationsFolder: path.join(dir, "missing-migrations"),
      }),
    ).toThrow(/找不到迁移目录/);
  });
});
