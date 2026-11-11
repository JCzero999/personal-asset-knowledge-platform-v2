import type { Library, WorkStatus } from "@/domain/objects";

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
