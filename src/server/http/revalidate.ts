import { revalidatePath } from "next/cache";

/**
 * 词表写入后的全站同步（ADR-016 §2.4）。
 *
 * 词表是全局数据：分类 / 标签改名、停用、合并后，工作台、检索、图谱、
 * 管理页与新建弹窗都必须立刻读到新状态。这些页面目前是 `force-dynamic`，
 * 本来每次请求都查库；这里仍然显式 revalidate，避免以后有人给页面加上
 * 缓存后出现「管理页改了、别的页还是旧名字」。只在路由处理器里调用。
 */
const vocabularyPages = [
  "/",
  "/workspace",
  "/search",
  "/graph",
  "/admin",
  "/admin/vocabulary/categories",
  "/admin/vocabulary/tags",
];

export function revalidateVocabulary(): void {
  for (const page of vocabularyPages) {
    try {
      revalidatePath(page);
    } catch {
      // 不在 Next 请求上下文（例如单元测试直接调服务）时忽略即可。
    }
  }
}
