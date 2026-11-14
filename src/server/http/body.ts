import { ValidationError } from "../../domain/errors";

/**
 * 可选请求体：空 body 视为 `{}`（`/extract`、`/score`、`/value-assess` 都是
 * 「点一下按钮」的接口，没有参数要传）；有 body 但不是合法 JSON 仍是 400。
 */
export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();

  if (!text.trim()) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

/** 必填请求体：空 body 也按「不是合法 JSON」处理，与既有写接口保持一致。 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();

  if (!text.trim()) {
    throw new ValidationError("请求体不是合法 JSON");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}
