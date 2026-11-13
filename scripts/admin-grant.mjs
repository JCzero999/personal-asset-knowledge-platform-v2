/**
 * 离线恢复通道（ADR-019 第 7 条）：给某个 Logto `sub` 补一个角色。
 *
 * 用法：
 *   npm run admin:grant -- <sub>            # 默认补 owner
 *   npm run admin:grant -- <sub> admin      # 指定角色
 *
 * 场景：所有 owner 都被停用、或管理员名单为空导致没人能进后台时，
 * 在服务器上直接执行本脚本恢复一个 owner。语义与
 * `src/server/services/user-service.ts#grantRoleBySub` 保持一致：
 * 用户不存在则创建并只给目标角色（不附默认 viewer），存在则恢复为 active 并追加角色，
 * 并写一条 `user.bootstrap` 审计（主体 cli:admin-grant）。
 *
 * 本脚本只做加法，不删数据；库表不存在时提示先启动一次应用完成迁移。
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(now = Date.now()) {
  let time = "";
  let remaining = now;
  for (let index = 0; index < 10; index += 1) {
    time = ENCODING[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  let random = "";
  for (const byte of randomBytes(16)) {
    random += ENCODING[byte & 31];
  }

  return time + random;
}

const sub = (process.argv[2] ?? "").trim();
const roleKey = (process.argv[3] ?? "owner").trim();

if (!sub) {
  console.error("用法：npm run admin:grant -- <sub> [owner|admin|editor|viewer]");
  process.exit(1);
}

const file = path.resolve(process.env.DATABASE_PATH?.trim() || "data/app.db");
if (!existsSync(file)) {
  console.error(`数据库不存在：${file}\n请先启动一次应用完成迁移，再执行本脚本。`);
  process.exit(1);
}

const sqlite = new Database(file);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const hasAuthzTables = sqlite
  .prepare("select count(*) as n from sqlite_master where type = 'table' and name in ('users', 'roles', 'user_roles')")
  .get().n === 3;

if (!hasAuthzTables) {
  console.error("授权表尚未创建：请先启动一次应用（会自动跑 0006 迁移），再执行本脚本。");
  sqlite.close();
  process.exit(1);
}

const role = sqlite.prepare("select key, label from roles where key = ?").get(roleKey);
if (!role) {
  const known = sqlite.prepare("select key from roles order by sort_order").all().map((row) => row.key);
  console.error(`未知角色：${roleKey}\n可用角色：${known.join(", ")}`);
  sqlite.close();
  process.exit(1);
}

const now = new Date().toISOString();
const userId = ulid();
let created = false;

const run = sqlite.transaction(() => {
  const existing = sqlite.prepare("select id from users where sub = ?").get(sub);
  let id = existing?.id;

  if (id) {
    sqlite.prepare("update users set state = 'active', last_seen_at = ? where id = ?").run(now, id);
  } else {
    created = true;
    id = userId;
    sqlite
      .prepare(
        `insert into users (id, sub, display_name, email, state, created_at, last_seen_at)
         values (?, ?, ?, null, 'active', ?, ?)`,
      )
      .run(id, sub, sub, now, now);
  }

  sqlite
    .prepare("insert into user_roles (user_id, role_key) values (?, ?) on conflict do nothing")
    .run(id, roleKey);

  sqlite
    .prepare(
      `insert into audit_events
         (id, actor_sub, actor_user_id, action, target_type, target_id, detail, result, created_at)
       values (?, 'cli:admin-grant', null, 'user.bootstrap', 'user', ?, ?, 'ok', ?)`,
    )
    .run(
      ulid(),
      id,
      JSON.stringify({ sub, role: roleKey, source: "admin:grant", created }),
      now,
    );

  return id;
});

try {
  const id = run();
  console.log(
    JSON.stringify(
      {
        ok: true,
        userId: id,
        sub,
        role: roleKey,
        roleLabel: role.label,
        created,
        database: file,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("补角色失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
