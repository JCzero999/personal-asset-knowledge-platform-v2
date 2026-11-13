import { normalizeCategory, normalizeTag } from "../../src/domain/vocabulary";
import type { DatabaseHandle } from "../../src/server/db/client";

/**
 * 测试夹具：直接往词表写一行。
 *
 * ADR-023 起标签不再允许隐式创建（`replaceObjectTags` 对未知标签抛
 * `TAG_NOT_FOUND`），所以需要标签的用例必须先把词条建出来。
 */

const NOW = "2026-01-01T00:00:00.000Z";

export function seedTag(handle: DatabaseHandle, label: string): string {
  const normalized = normalizeTag(label);
  const id = `tag_${normalized.replace(/[^a-z0-9]+/g, "_") || "x"}`;

  handle.sqlite
    .prepare(
      `insert into tags (id, label, normalized, sort_order, created_at, updated_at)
       values (?, ?, ?, 0, ?, ?)
       on conflict(normalized) do nothing`,
    )
    .run(id, label, normalized, NOW, NOW);

  return (
    handle.sqlite.prepare("select id from tags where normalized = ?").get(normalized) as {
      id: string;
    }
  ).id;
}

export function seedCategory(
  handle: DatabaseHandle,
  label: string,
  code = `c-${normalizeCategory(label).replace(/[^a-z0-9]+/g, "-") || "x"}`,
): string {
  handle.sqlite
    .prepare(
      `insert into categories (code, label, normalized, sort_order, state, is_system, created_at, updated_at)
       values (?, ?, ?, 500, 'active', 0, ?, ?)
       on conflict(normalized) do nothing`,
    )
    .run(code, label, normalizeCategory(label), NOW, NOW);

  return (
    handle.sqlite.prepare("select code from categories where normalized = ?").get(
      normalizeCategory(label),
    ) as { code: string }
  ).code;
}
