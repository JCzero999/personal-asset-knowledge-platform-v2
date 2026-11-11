/**
 * 客户端调用 `/api/objects*` 时的错误解析。
 *
 * 服务端错误信封固定为 `{ error: { code, message, details? } }`，
 * 这里把英文字段名换成中文，并把少数需要特殊提示的错误码统一成用户能
 * 直接行动的文案（例如 409 冲突要提示刷新）。
 */

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

const fieldLabels: Record<string, string> = {
  type: "类型",
  title: "标题",
  description: "说明",
  library: "归属",
  format: "作品形态",
  status: "状态",
  categories: "分类",
  tags: "标签",
  priority: "优先级",
  sourceNote: "来源说明",
  reason: "迁移理由",
  expectedRevision: "版本号",
};

/** 服务端 message 用英文字段名开头，展示前换成用户能看懂的字段名。 */
export function humanizeMessage(message: string, field?: string | null): string {
  if (!field) return message;

  const label = fieldLabels[field];
  if (!label) return message;

  if (message.startsWith(`${field} `)) {
    return `${label}${message.slice(field.length)}`;
  }

  return message;
}

/** 取出校验错误里指向的字段，用于表单高亮。 */
export function apiErrorField(data: unknown): string | null {
  const field = (data as ApiErrorBody | null)?.error?.details?.field;
  return typeof field === "string" ? field : null;
}

export function messageForError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "CONFLICT":
      return "对象已被修改，请刷新后重试。";
    case "UNAUTHORIZED":
      return "登录状态已失效，请刷新页面后重试。";
    case "NOT_FOUND":
      return "对象不存在或已被删除。";
    default:
      return fallback;
  }
}
