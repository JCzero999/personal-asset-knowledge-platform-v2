import { describe, expect, it } from "vitest";

import { DomainError, NotFoundError } from "../../src/domain/errors";
import { fail, fromError, ok } from "../../src/server/http/respond";

describe("http respond envelope", () => {
  it("错误响应固定为 { error: { code, message, details } }", async () => {
    const response = fail("VALIDATION_FAILED", "标题不能为空", { field: "title" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "标题不能为空",
        details: { field: "title" },
      },
    });
  });

  it("DomainError 映射到对应状态码", async () => {
    const response = fromError(new NotFoundError("对象不存在", { id: "x" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND", details: { id: "x" } },
    });
  });

  it("未知异常收敛为 500，不泄露内部信息", async () => {
    const response = fromError(new Error("SQLITE_BUSY at /secret/path"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INTERNAL", message: "服务内部错误" },
    });
  });

  it("成功响应直接返回数据", async () => {
    const response = ok({ id: "01H" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "01H" });
  });

  it("DomainError 实例可被 isDomainError 识别", () => {
    expect(fromError(new DomainError("CONFLICT", "冲突")).status).toBe(409);
  });
});
