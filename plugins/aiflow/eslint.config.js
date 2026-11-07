import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["examples/**", "**/*.tsx", "**/dist/**", "**/node_modules/**", "**/coverage/**", "e2e/**", "packages/web/**", "**/*.config.*", "eslint.config.js", ".dependency-cruiser.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: ["./tsconfig.check.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      // Port-Implementierungen (In-Memory, Dateisystem) erfüllen async-Interfaces ohne await.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["packages/*/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
