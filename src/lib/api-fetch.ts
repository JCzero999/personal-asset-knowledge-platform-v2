/**
 * 浏览器端 JSON 调用的最小封装。
 *
 * `apiRequest` 只抛一条可展示文案；有些页面需要区分「后端还没就绪」与
 * 「业务校验失败」，并根据服务端 `details` 做就地提示，这里把状态码与
 * 错误详情一起返回，由页面决定怎么显示。
 */

export type ApiCallResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      message: string;
      details: Record<string, unknown> | null;
      /** 响应不是 JSON 且状态为 404 / 503：通常是路由还不存在。 */
      unavailable: boolean;
    };

export async function callJson<T>(url: string, init?: RequestInit): Promise<ApiCallResult<T>> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch {
    return {
      ok: false,
      status: 0,
      message: "网络异常，请检查连接后重试。",
      details: null,
      unavailable: false,
    };
  }

  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  const body = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const envelope = (body as {
      error?: { message?: string; details?: Record<string, unknown> };
    } | null)?.error;
    const unavailable = !isJson && (response.status === 404 || response.status === 503);

    return {
      ok: false,
      status: response.status,
      message: envelope?.message ?? (unavailable ? "后端未就绪" : `服务返回 ${response.status}`),
      details: envelope?.details ?? null,
      unavailable,
    };
  }

  return { ok: true, data: body as T };
}
