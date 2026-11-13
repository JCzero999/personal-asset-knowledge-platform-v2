import { isLibrary, type Library } from "@/domain/objects";

import {
  DEFAULT_SEARCH_MODE,
  searchModes,
  type SearchMode,
} from "./search-query";
import type { WorkspaceSearchParams } from "./workspace-filters";

/**
 * 检索页的 URL 状态。
 *
 * 与工作台筛选一样，URL 是唯一真相：页面只读参数，表单只负责写回地址。
 * 区别是检索参数非法时不做静默降级——用户看到明确原因，才不会被
 * 「结果不对」困住。
 */

export const DEFAULT_SEARCH_THRESHOLD = 0.2;
export const MAX_SEARCH_QUESTION = 200;

export interface SearchThresholdOption {
  value: number;
  label: string;
}

/** 表单里给出的几档常用阈值，0.2 与服务端默认值一致。 */
export const searchThresholdOptions: SearchThresholdOption[] = [
  { value: 0.2, label: "默认 · 0.2" },
  { value: 0.35, label: "平衡 · 0.35" },
  { value: 0.5, label: "较严 · 0.5" },
  { value: 0.7, label: "严格 · 0.7" },
];

export interface SearchParamsState {
  /** 已 trim 的检索词；可能为空（此时不发起检索）。 */
  q: string;
  library: Library | null;
  threshold: number;
  /** hybrid / lexical / semantic（ADR-024），默认 hybrid。 */
  mode: SearchMode;
  /** 参数非法时的中文说明；有值时不发起检索。 */
  error: string | null;
}

function readParam(params: WorkspaceSearchParams, key: string): string {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() ?? "";
}

export function parseSearchParams(params: WorkspaceSearchParams): SearchParamsState {
  const q = readParam(params, "q");
  let error: string | null = null;

  const libraryRaw = readParam(params, "library");
  let library: Library | null = null;
  if (libraryRaw) {
    if (isLibrary(libraryRaw)) {
      library = libraryRaw;
    } else {
      error = "库别参数无效，只能筛选内库或外库。";
    }
  }

  const thresholdRaw = readParam(params, "threshold");
  let threshold = DEFAULT_SEARCH_THRESHOLD;
  if (thresholdRaw) {
    const value = Number(thresholdRaw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      error ??= "相似度阈值需要在 0 到 1 之间。";
    } else {
      threshold = value;
    }
  }

  if (q.length > MAX_SEARCH_QUESTION) {
    error ??= `搜索词不能超过 ${MAX_SEARCH_QUESTION} 个字符（当前 ${q.length} 个）。`;
  }

  const modeRaw = readParam(params, "mode");
  let mode: SearchMode = DEFAULT_SEARCH_MODE;
  if (modeRaw) {
    if ((searchModes as readonly string[]).includes(modeRaw)) {
      mode = modeRaw as SearchMode;
    } else {
      error ??= "检索模式无效，只能是 hybrid / lexical / semantic。";
    }
  }

  return { q, library, threshold, mode, error };
}

/** 生成干净的检索地址：默认值不写进 URL，清空检索回到 `/search`。 */
export function buildSearchHref(state: {
  q: string;
  library?: Library | null;
  threshold?: number;
  mode?: SearchMode;
}): string {
  const params = new URLSearchParams();
  const q = state.q.trim();

  if (q) params.set("q", q);
  if (state.library) params.set("library", state.library);
  if (state.threshold !== undefined && state.threshold !== DEFAULT_SEARCH_THRESHOLD) {
    params.set("threshold", String(state.threshold));
  }
  if (state.mode && state.mode !== DEFAULT_SEARCH_MODE) {
    params.set("mode", state.mode);
  }

  const query = params.toString();
  return query ? `/search?${query}` : "/search";
}

/** 表单选项需要覆盖手改 URL 里的自定义阈值，否则下拉框会显示空白。 */
export function thresholdOptionsFor(threshold: number): SearchThresholdOption[] {
  if (searchThresholdOptions.some((option) => option.value === threshold)) {
    return searchThresholdOptions;
  }

  return [...searchThresholdOptions, { value: threshold, label: `自定义 · ${threshold}` }];
}
