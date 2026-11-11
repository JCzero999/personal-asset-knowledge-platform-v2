import {
  apiErrorField,
  humanizeMessage,
  messageForError,
  type ApiErrorBody,
} from "./api-error";

/**
 * 浏览器端调用 `/api/*` 的统一入口。
 *
 * 服务端错误信封固定为 `{ error: { code, message, details? } }`；
 * 这里把网络异常、错误码和字段名统一翻译成可直接展示的中文。
 */

export class ApiFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiFailure";
  }
}

export function jsonBodyInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function apiRequest<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiFailure("网络异常，请检查连接后重试。");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const data = (await response.json().catch(() => null)) as (ApiErrorBody & T) | null;

  if (!response.ok) {
    const apiError = data?.error;
    const field = apiErrorField(data);
    const message = humanizeMessage(apiError?.message ?? "操作失败，请稍后再试。", field);
    throw new ApiFailure(messageForError(apiError?.code, message));
  }

  return data as T;
}

export function apiErrorMessage(cause: unknown): string {
  return cause instanceof ApiFailure ? cause.message : "网络异常，请检查连接后重试。";
}
