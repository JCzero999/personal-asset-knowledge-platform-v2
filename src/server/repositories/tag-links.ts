import { eq } from "drizzle-orm";

import { DomainError, ValidationError } from "../../domain/errors";
import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_OBJECT,
  normalizeTag,
  normalizeTagList,
  tagLabelProblem,
} from "../../domain/vocabulary";
import type { AppDatabase } from "../db/client";
import { objectTags, tags } from "../db/schema";

/** better-sqlite3 事务里的 drizzle 句柄，仅供同步写入使用。 */
type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/**
 * 对象 ↔ 标签的写入路径（ADR-016 第 3、7 条，ADR-023 第 8 条收紧）。
 *
 * - 标签以 `tags.normalized` 为唯一键：先归一化，命中即复用已有标签（保留首次写法）；
 * - `object_tags` 存 tag_id，所以重命名标签是 O(1)，全站立即生效；
 * - **未知标签直接拒绝**（TAG_NOT_FOUND）：新建只能走「＋ 自定义」词表接口，
 *   堵住绕过词表、静默造标签的入口；
 * - 对象是软删除，删除时不清理链接——使用次数统计靠 join objects 排除软删。
 */
export function replaceObjectTags(tx: Tx, objectId: string, labels: readonly string[]): void {
  const cleaned = normalizeTagList(labels);

  if (cleaned.length > MAX_TAGS_PER_OBJECT) {
    throw new ValidationError(`最多 ${MAX_TAGS_PER_OBJECT} 个标签`, {
      max: MAX_TAGS_PER_OBJECT,
      count: cleaned.length,
    });
  }

  for (const label of cleaned) {
    const problem = tagLabelProblem(label);

    if (problem) {
      throw new ValidationError(problem, { tag: label, max: MAX_TAG_LENGTH });
    }
  }

  tx.delete(objectTags).where(eq(objectTags.objectId, objectId)).run();

  if (cleaned.length === 0) return;

  for (const label of cleaned) {
    const normalized = normalizeTag(label);
    const row = tx
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.normalized, normalized))
      .get();

    if (!row) {
      throw new DomainError(
        "TAG_NOT_FOUND",
        `标签「${label}」不存在，请先通过「自定义」新建`,
        { tag: label, normalized },
      );
    }

    tx.insert(objectTags)
      .values({ objectId, tagId: row.id })
      .onConflictDoNothing()
      .run();
  }
}
