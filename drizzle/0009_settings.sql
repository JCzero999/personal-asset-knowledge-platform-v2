-- 系统设置与权限（ADR-025）：LLM 供应商配置落库
--
-- 存储语义：
--   settings.key             设置项稳定键（v1 只有 'llm'）
--   settings.value_encrypted 整段 JSON 的 AES-256-GCM 密文（含 API Key）
--   settings.updated_at      UTC ISO-8601
--   settings.updated_by      操作者 sub 快照，不做外键（审计可读性优先）
--
-- 非密钥字段（provider / baseUrl / model / timeoutMs）与 API Key 一起加密，
-- 避免出现「漏加密一列」的可能；读取接口只在内存里解密并返回掩码。
-- 迁移只建表，不写默认行：没有行时接口按 infra/lightrag/.env 推导当前生效值。

CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_encrypted` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "settings_key_check" CHECK(length(key) > 0)
);
--> statement-breakpoint
-- 权限目录新增两项（仅所有者与管理员）。代码常量在 src/server/authz.ts，
-- 启动时 assertAuthzCatalog() 会逐项核对，两边必须同时改。
INSERT INTO `permissions` (`key`, `label`, `group_key`, `sort_order`) VALUES
	('settings:read', '查看系统设置', '系统', 140),
	('settings:write', '修改系统设置', '系统', 150);
--> statement-breakpoint
INSERT INTO `role_permissions` (`role_key`, `permission_key`) VALUES
	('owner', 'settings:read'),
	('owner', 'settings:write'),
	('admin', 'settings:read'),
	('admin', 'settings:write');
