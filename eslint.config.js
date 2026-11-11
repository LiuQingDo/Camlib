import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

/**
 * 第一版 lint：目标是先把问题**暴露**出来，而不是一次性拦住所有人。
 *
 * - `js.configs.recommended` 与 `tseslint.configs.recommended` 里的规则
 *   通过 `downgradeToWarn` 统一降成 warn；
 * - 只有两条规则保持 error（存量代码已符合，用来守住底线）：
 *   `@typescript-eslint/no-unused-vars`、`@typescript-eslint/no-explicit-any`；
 * - `prettier` 只关闭与格式化冲突的规则，不在这里判断格式（格式归 prettier）。
 */
const STRICT_RULES = new Set([
  "@typescript-eslint/no-unused-vars",
  "@typescript-eslint/no-explicit-any",
]);

function downgradeToWarn(configs) {
  return configs.map((config) => {
    if (!config.rules) return config;
    const rules = {};
    for (const [name, value] of Object.entries(config.rules)) {
      if (STRICT_RULES.has(name)) {
        rules[name] = value;
        continue;
      }
      const [severity, ...options] = Array.isArray(value) ? value : [value];
      rules[name] = severity === "off" || severity === 0 ? value : ["warn", ...options];
    }
    return { ...config, rules };
  });
}

export default tseslint.config(
  {
    // 构建产物、依赖、Rust 侧都不归 eslint 管。
    ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
  },
  downgradeToWarn([
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["src/**/*.ts"],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        globals: { ...globals.browser },
      },
    },
    {
      // 测试文件跑在 vitest 里，额外需要 describe/it/expect 等全局。
      files: ["src/**/*.test.ts"],
      languageOptions: { globals: { ...globals.browser, ...globals.node } },
    },
  ]),
  {
    files: ["src/**/*.ts"],
    rules: {
      // 关键规则：保持 error。未使用的参数用 `_` 前缀显式表达「有意不用」。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  prettier,
);
