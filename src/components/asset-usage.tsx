"use client";

import { useEffect } from "react";

import type { AssetUsageKind } from "@/domain/objects";

/**
 * 有效调用上报（v2.1 §2）。
 *
 * 只由明确的用户动作触发：详情停留 8 秒、打开原文、复制正文。
 * 服务端负责 1 小时去重与归属校验，这里上报失败一律静默 —— 统计
 * 不该打断阅读，也不该弹错误。
 */

const DWELL_MS = 8000;

export async function reportAssetUsage(
  objectId: string,
  kind: AssetUsageKind,
): Promise<void> {
  try {
    await fetch(`/api/objects/${objectId}/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
      keepalive: true,
    });
  } catch {
    // 静默：404 / 409 / 断网都只影响计数。
  }
}

/** 详情打开 8 秒记一次 `detail_dwell`；每次挂载只报一次（切换对象重新计时）。 */
export function AssetDwellTracker({ objectId }: { objectId: string }) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reportAssetUsage(objectId, "detail_dwell");
    }, DWELL_MS);

    return () => window.clearTimeout(timer);
  }, [objectId]);

  return null;
}
