import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const appFiles = [
  "src/**/*.{ts,tsx}",
  "tests/**/*.{ts,tsx}",
  "monitor/server.mjs",
  "monitor/v4/src/**/*.{js,jsx,ts,tsx}",
  "monitor/v5/src/**/*.{js,jsx,ts,tsx}",
  "website/src/**/*.{ts,tsx}",
];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "monitor/public-v3/**", ".factory/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: appFiles,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      complexity: ["warn", { max: 20 }],
      "max-lines": ["warn", { max: 1_200, skipBlankLines: true, skipComments: true }],
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "typeLike", format: ["PascalCase"] },
        { selector: "function", format: ["camelCase", "PascalCase"] },
        {
          selector: "variableLike",
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
          leadingUnderscore: "allowSingleOrDouble",
          trailingUnderscore: "allow",
          filter: {
            regex: "^[a-z][a-zA-Z0-9]*(_[a-zA-Z0-9]+)+$",
            match: false,
          },
        },
      ],
    },
  },
  {
    files: [
      "monitor/v4/src/**/*.{js,jsx,ts,tsx}",
      "monitor/v5/src/**/*.{js,jsx,ts,tsx}",
      "website/src/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Without a React plugin, ESLint cannot see JSX usages of imported components.
    files: ["monitor/v4/src/**/*.jsx", "monitor/v5/src/**/*.jsx"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "website/tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["scripts/**/*.{js,mjs}", "*.{js,mjs,cjs,ts}", "website/*.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
);
