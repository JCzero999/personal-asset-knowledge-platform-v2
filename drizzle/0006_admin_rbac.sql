-- 管理后台用户 / 角色 / 权限模型（ADR-019）
-- 六张表：users / roles / permissions / role_permissions / user_roles / audit_events。
-- 角色、权限与矩阵在此灌入；代码常量（src/server/authz.ts）是源，启动与测试各校验一次。
-- 迁移不预置 users 行：此时还不知道 sub，首个 owner 由 ADMIN_SUBS 在登录时引导（ADR-019 第 7 条）。
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`sub` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT "users_state_check" CHECK(state in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_sub_uq` ON `users` (`sub`);--> statement-breakpoint
CREATE TABLE `roles` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`is_system` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`group_key` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_key` text NOT NULL,
	`permission_key` text NOT NULL,
	PRIMARY KEY(`role_key`, `permission_key`),
	FOREIGN KEY (`role_key`) REFERENCES `roles`(`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_key`) REFERENCES `permissions`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text NOT NULL,
	`role_key` text NOT NULL,
	PRIMARY KEY(`user_id`, `role_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_key`) REFERENCES `roles`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_key`);--> statement-breakpoint
-- actor_user_id 故意不加外键（ADR-019 第 8 条）：用户删除或 sub 变更后审计仍可读。
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_sub` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`result` text DEFAULT 'ok' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "audit_events_result_check" CHECK(result in ('ok', 'error', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_user_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_target_idx` ON `audit_events` (`target_type`, `target_id`);--> statement-breakpoint
INSERT INTO `roles` (`key`, `label`, `is_system`, `sort_order`) VALUES
	('owner', '所有者', 1, 10),
	('admin', '管理员', 1, 20),
	('editor', '编辑', 1, 30),
	('viewer', '只读', 1, 40);
--> statement-breakpoint
INSERT INTO `permissions` (`key`, `label`, `group_key`, `sort_order`) VALUES
	('object:read', '查看内容', '内容', 10),
	('object:write', '新建与编辑内容', '内容', 20),
	('object:delete', '删除内容（软删）', '内容', 30),
	('object:export', '导出 Markdown', '内容', 40),
	('vocabulary:format:write', '管理形态词表', '词表', 50),
	('vocabulary:tag:write', '管理标签词表', '词表', 60),
	('content:sync', '手动同步队列', '运维', 70),
	('content:parse', '推进解析状态', '运维', 80),
	('system:read', '查看运行时信息', '后台', 90),
	('audit:read', '查看审计日志', '后台', 100),
	('user:read', '查看用户与角色', '账号', 110),
	('user:write', '修改用户角色与状态', '账号', 120),
	('role:write', '修改角色定义（预留）', '账号', 130);
--> statement-breakpoint
-- 4 角色 × 13 权限矩阵，逐格对应 ADR-019 表格。
INSERT INTO `role_permissions` (`role_key`, `permission_key`)
SELECT 'owner', `key` FROM `permissions`;
--> statement-breakpoint
INSERT INTO `role_permissions` (`role_key`, `permission_key`)
SELECT 'admin', `key` FROM `permissions` WHERE `key` NOT IN ('user:write', 'role:write');
--> statement-breakpoint
INSERT INTO `role_permissions` (`role_key`, `permission_key`) VALUES
	('editor', 'object:read'),
	('editor', 'object:write');
--> statement-breakpoint
INSERT INTO `role_permissions` (`role_key`, `permission_key`) VALUES
	('viewer', 'object:read');
