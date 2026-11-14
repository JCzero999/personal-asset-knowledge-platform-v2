import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      // 单测绝不连真实模型：把 LightRAG 的 .env 指到不存在的路径，
      // 让 AI 相关代码走「未绑定模型 → 确定性兜底」分支，结果可复现。
      LIGHTRAG_ENV_PATH: path.resolve(import.meta.dirname, "tests", ".no-lightrag-env"),
    },
  },
});
