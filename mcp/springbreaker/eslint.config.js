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

      "@typescript-eslint/no-explicit-any": "error",

      // Allow template literals freely
      "@typescript-eslint/restrict-template-expressions": "off",

      // Allow void expressions in arrow functions (common in logger patterns)
      "@typescript-eslint/no-confusing-void-expression": "off",

      // Allow async functions without await (may be async for interface compat)
      "@typescript-eslint/require-await": "off",

      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",

      // Allow promises in void-return contexts (SIGTERM handlers, etc.)
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
    },
  },

  // Test doubles and decoded JSON intentionally cross dynamic boundaries.
  // Production source remains fully checked by the rules above.
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
