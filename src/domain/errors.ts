/**
 * 统一错误契约。
 *
 * 领域层只抛出 `DomainError`（带稳定错误码），由 `server/http/respond.ts`
 * 统一映射为 `{ error: { code, message, details? } }` 响应体。
 */

export const errorCodes = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_TRANSITION",
  "EXTERNAL_LIBRARY_PRACTICED",
  "CONSTRAINT_VIOLATION",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface ErrorDetails {
  [key: string]: unknown;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string, details?: ErrorDetails) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: ErrorDetails) {
    super("CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: ErrorDetails) {
    super("VALIDATION_FAILED", message, details);
    this.name = "ValidationError";
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
