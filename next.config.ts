import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 开发指示器会出现在左下角，污染首页截图与视觉验收。
  devIndicators: false,
  // 验收脚本会用 `AUTH_MODE=mock` 另起一个实例截已登录页面（3101），
  // 与 3000 的 dev server 共用 .next 会撞锁，因此允许换构建目录。
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
