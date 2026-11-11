import { isDomainError, type ErrorCode } from "../../domain/errors";

/**
 * 统一响应信封：成功直接返回数据；失败固定为
 * `{ error: { code, message, details? } }`。
 *
 * `/api/health` 保持原有形状，新接口一律走这里。
 */

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

const statusByCode: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  INVALID_TRANSITION: 409,
  EXTERNAL_LIBRARY_PRACTICED: 409,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONSTRAINT_VIOLATION: 422,
  INTERNAL: 500,
};

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function created<T>(data: T): Response {
  return Response.json(data, { status: 201 });
}

export function empty(): Response {
  return new Response(null, { status: 204 });
}

export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: ErrorEnvelope = { error: { code, message, ...(details ? { details } : {}) } };
  return Response.json(body, { status: statusByCode[code] });
}

/** 把任意异常收敛成信封；未知异常不外泄内部信息。 */
export function fromError(error: unknown): Response {
  if (isDomainError(error)) {
    return fail(error.code, error.message, error.details);
  }

  console.error("[http] unhandled error", error);
  return fail("INTERNAL", "服务内部错误");
}
