import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    // `NEXT_DIST_DIR` 验收实例的第二份构建产物（scripts/phase5-capture.mjs）
    ".next-mock/**",
    // 生产运行时验收的构建产物（scripts/phase6d-capture.mjs 的 PHASE6D_PROD=1）
    ".next-build/**",
    // RAGFlow 故障演练的隔离实例构建产物
    ".next-failtest/**",
    // 大模型配置 / 预览验收的隔离实例构建产物
    ".next-verify/**",
    // /graph 液态玻璃与 ego 安全区验收的隔离实例构建产物
    ".next-glass/**",
    ".next-glass-ego/**",
    // v2.1 界面验收的隔离实例构建产物（scripts/verify-v21-ui.mjs、verify-v21-batch2.mjs）
    ".next-v21/**",
    ".next-v21b2/**",
    ".venv/**",
    "**/.venv/**",
    "agents/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // 形态已经词表化（ADR-016 第 5 条）：业务代码只能读 /api/vocabulary 或
    // listVocabulary()，禁止再把内置形态名单当常量 import 回来——那正是过去
    // 「改一处漏一处」的来源。种子只允许在领域定义、迁移文档与测试里出现。
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/domain/objects.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/domain/objects"],
              importNames: ["SYSTEM_FORMAT_SEEDS"],
              message:
                "形态词表请读 /api/vocabulary 或 listVocabulary()，不要再用代码常量（ADR-016）。",
            },
          ],
        },
      ],
    },
  },
]);
