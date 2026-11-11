import { ConflictError, DomainError } from "../../domain/errors";

/**
 * 数据库驱动的约束错误 → 领域错误。
 *
 * 应用层已经先校验一次；这里接住并发与绕过服务层的写入，
 * 保证调用方只看到稳定错误码，不依赖 SQLite 的英文报错文本。
 */
export function translateSqliteError(error: unknown, prefix = ""): never {
  const message = error instanceof Error ? error.message : String(error);
  const constraint = /constraint failed:\s*(.+)$/i.exec(message)?.[1]?.trim();

  if (/CHECK constraint failed/i.test(message)) {
    throw new DomainError(
      "CONSTRAINT_VIOLATION",
      `${prefix}数据库约束拒绝写入：${message}`,
      constraint ? { constraint } : undefined,
    );
  }

  if (/NOT NULL constraint failed/i.test(message)) {
    throw new DomainError(
      "CONSTRAINT_VIOLATION",
      `${prefix}必填字段缺失：${message}`,
      constraint ? { constraint } : undefined,
    );
  }

  if (/UNIQUE constraint failed/i.test(message)) {
    throw new ConflictError(
      `${prefix}唯一约束冲突：${message}`,
      constraint ? { constraint } : undefined,
    );
  }

  if (/FOREIGN KEY constraint failed/i.test(message)) {
    throw new ConflictError(`${prefix}外键约束冲突：${message}`);
  }

  throw error;
}
