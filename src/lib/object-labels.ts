import type {
  Library,
  ObjectOrigin,
  ObjectSource,
  ObjectType,
  Priority,
  WorkStatus,
} from "@/domain/objects";

/** 界面统一使用的中文状态名，服务端组件与客户端组件共用。 */
export const statusLabels: Record<WorkStatus, string> = {
  draft: "草稿",
  finished: "已完成",
  published: "已发布",
  practiced: "已实践",
};

export const libraryLabels: Record<Library, string> = {
  internal: "内库",
  external: "外库",
};

export const objectTypeLabels: Record<ObjectType, string> = {
  asset: "资产",
  work: "作品",
};

export const priorityLabels: Record<Priority, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

export const sourceLabels: Record<ObjectSource, string> = {
  handwritten: "手写",
  ai_extracted: "AI 提取",
};

export const originLabels: Record<ObjectOrigin, string> = {
  self: "自建",
  imported: "导入",
};

export const contentRoleLabels = {
  primary: "主内容",
  attachment: "附件",
} as const;

/** 资产来源（规格 v2.0）：AI 提炼 / 外部直入 / 实践沉淀。 */
export const sourceTypeLabels: Record<"ai_extract" | "external_direct" | "practiced_work", string> = {
  ai_extract: "AI 提炼",
  external_direct: "外部直入",
  practiced_work: "实践沉淀",
};

