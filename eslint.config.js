import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.vite/**",
      "**/dev-dist/**",
      "packages/client/public/**",
      // Local dev WORKSPACE_PATH default ($repo/workspace) is gitignored
      // already; mirror it here so a project the user has cloned inside
      // their dev workspace doesn't get picked up by the typed lint
      // (which then errors because those files aren't in any tsconfig).
      "workspace/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["packages/server/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: {
        project: ["./packages/server/tsconfig.json", "./tests/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Noisy rules in single-tenant tool code where the SDK boundary
      // is intentionally loose. Disabling these saves a triage wave
      // that's mostly false-positive for our threat model.
      // - no-explicit-any: SDK message shapes are union types we
      //   re-shape; documented `as unknown as ...` casts are explicit.
      "@typescript-eslint/no-explicit-any": "off",
      // - no-unsafe-*: SDK return types use `unknown` extensively;
      //   our validators handle the runtime check.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // - restrict-template-expressions: log lines and error messages
      //   often template-interpolate `unknown` from typed errors.
      "@typescript-eslint/restrict-template-expressions": "off",
      // Fastify route plugins are conventionally `async (fastify) => {...}`
      // even when they don't await internally — the framework expects
      // an async function. Disabling the rule avoids requiring a
      // bogus `await Promise.resolve()` inside every plugin body.
      "@typescript-eslint/require-await": "off",
      // SDK message shapes are loose at the boundary; templated logs
      // and debug strings often reference object fields that may be
      // unknown shape. The runtime fallback is "[object Object]"
      // which is acceptable for diagnostic logs.
      "@typescript-eslint/no-base-to-string": "off",
      // Stylistic preferences with subjective tradeoffs; the codebase
      // has explicit ternaries and `if`-guards that read fine. Leaving
      // off so a sweep doesn't churn dozens of files for cosmetic
      // gain. Flip back on per-PR if a particular module would
      // benefit.
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/prefer-for-of": "off",
    },
  },
  {
    files: ["packages/client/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: {
        project: ["./packages/client/tsconfig.json", "./packages/client/tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Stick to the canonical hooks rules. v7's `recommended` set
      // pulls in the React Compiler rule pack (set-state-in-effect,
      // refs, purity, immutability, preserve-manual-memoization,
      // static-components, error-boundaries, etc.) — those are
      // aspirational checks for code that opts INTO the React
      // Compiler. pi-forge doesn't, and many of the patterns those
      // rules flag (refresh-on-state-change effects, ref mutations
      // for plumbing like AbortControllers, intentional re-renders
      // on websocket reconnect) are deliberate design choices in
      // this codebase. Re-enable individually if a particular rule
      // turns out to surface real bugs.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Same noise-disables as the server config above.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      // Fastify route plugins are conventionally `async (fastify) => {...}`
      // even when they don't await internally — the framework expects
      // an async function. Disabling the rule avoids requiring a
      // bogus `await Promise.resolve()` inside every plugin body.
      "@typescript-eslint/require-await": "off",
      // SDK message shapes are loose at the boundary; templated logs
      // and debug strings often reference object fields that may be
      // unknown shape. The runtime fallback is "[object Object]"
      // which is acceptable for diagnostic logs.
      "@typescript-eslint/no-base-to-string": "off",
      // Stylistic preferences with subjective tradeoffs; the codebase
      // has explicit ternaries and `if`-guards that read fine. Leaving
      // off so a sweep doesn't churn dozens of files for cosmetic
      // gain. Flip back on per-PR if a particular module would
      // benefit.
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/prefer-for-of": "off",
    },
  },
  // Plain JS files (this very config, scripts/*.mjs) don't have a
  // tsconfig; turn off the type-aware rules and inject Node globals
  // so they lint cleanly without a per-file `/* global console */`
  // ceremony.
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
