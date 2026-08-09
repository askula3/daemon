import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores — replaces ignorePatterns from legacy config
  {
    ignores: ["dist/", "node_modules/", "*.js", "*.mjs", "*.cjs"],
  },

  // Base recommended rules (non type-aware — safe everywhere)
  ...tseslint.configs.recommended,

  // Type-aware recommended rules — stricter, requires project reference
  ...tseslint.configs.recommendedTypeChecked,

  // Project-level overrides
  {
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.json", "./test/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused params when prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Don't require explicit return types
      "@typescript-eslint/explicit-function-return-type": "off",

      // Warn on `any` usage instead of error
      "@typescript-eslint/no-explicit-any": "warn",

      // Allow template literals freely
      "@typescript-eslint/restrict-template-expressions": "off",

      // Allow void expressions in arrow functions (common in logger patterns)
      "@typescript-eslint/no-confusing-void-expression": "off",

      // Allow async functions without await (may be async for interface compat)
      "@typescript-eslint/require-await": "off",

      // Downgrade unsafe-any rules to warnings — the codebase uses JSON.parse etc.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",

      // Allow promises in void-return contexts (SIGTERM handlers, etc.)
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
    },
  },
);
