-- 检索影子列与归属索引（ADR-024 第 2、9 条）
--
-- `title_norm` / `description_norm` 由 sqlite-object-repository 在 create / update
-- 时用 normalizeSearchText() 写入；本迁移只加列与索引，存量回填由
-- openDatabase() 在迁移完成后用同一个 TS 函数执行（SQLite 没有 NFKC）。
--
-- 索引 `objects_owner_scope_idx` 把词法扫描面收敛到「当前用户 + 未删除 + 未归档」，
-- instr 本身不走索引，靠它缩小候选行。

ALTER TABLE `objects` ADD `title_norm` text;--> statement-breakpoint
ALTER TABLE `objects` ADD `description_norm` text;--> statement-breakpoint
CREATE INDEX `objects_owner_scope_idx` ON `objects` (`owner_sub`,`deleted_at`,`archived_at`);
