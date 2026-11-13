import type { Metadata } from "next";

import { GalaxyScene } from "@/components/galaxy-scene";
import { GALAXY_PALETTE } from "@/lib/galaxy-config";

export const metadata: Metadata = {
  title: "星系背景静态图",
  robots: { index: false, follow: false },
};

/**
 * 首页星系静态图的渲染舞台（ADR-020）。
 *
 * 只放场景、不放任何文字与 UI，供 `scripts/phase5-capture.mjs` 在
 * 1920×1080 与 1170×2532 两个尺寸下无头截图，产物写入 `public/galaxy/`。
 * 不进导航、不可被搜索引擎索引。
 */
export default function GalaxyPosterPage() {
  return (
    <main className="galaxy-poster-stage" style={{ background: GALAXY_PALETTE.voidDeep }}>
      <GalaxyScene posterMode />
    </main>
  );
}
