import { describe, expect, it } from "vitest";

import { ConflictError, DomainError } from "../../src/domain/errors";
import { translateSqliteError } from "../../src/server/repositories/sqlite-errors";

describe("translateSqliteError", () => {
  it("CHECK / NOT NULL 翻译为 CONSTRAINT_VIOLATION 并带约束名", () => {
    const check = new Error(
      "CHECK constraint failed: objects_external_not_practiced",
    );
    expect(() => translateSqliteError(check)).toThrow(DomainError);
    expect(() => translateSqliteError(check)).toThrow(/外部库|数据库约束/);

    try {
      translateSqliteError(check);
    } catch (error) {
      expect((error as DomainError).code).toBe("CONSTRAINT_VIOLATION");
      expect((error as DomainError).details?.constraint).toBe(
        "objects_external_not_practiced",
      );
    }

    try {
      translateSqliteError(
        new Error("NOT NULL constraint failed: content_refs.owner_id"),
      );
    } catch (error) {
      expect((error as DomainError).code).toBe("CONSTRAINT_VIOLATION");
      expect((error as DomainError).message).toContain("必填字段缺失");
    }
  });

  it("UNIQUE / FOREIGN KEY 翻译为 ConflictError", () => {
    for (const message of [
      "UNIQUE constraint failed: sync_jobs.id",
      "FOREIGN KEY constraint failed",
    ]) {
      try {
        translateSqliteError(new Error(message), "内容引用");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictError);
        expect((error as DomainError).code).toBe("CONFLICT");
        expect((error as Error).message).toContain("内容引用");
      }
    }
  });

  it("其它错误原样抛出，不包装", () => {
    const error = new Error("disk I/O error");
    expect(() => translateSqliteError(error)).toThrow(error);
  });
});
