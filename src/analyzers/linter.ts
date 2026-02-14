import { ESLint } from "eslint";

interface LintResult {
  issues: Array<{
    line: number;
    column: number;
    severity: string;
    message: string;
    rule: string;
  }>;
  summary: {
    errorCount: number;
    warningCount: number;
    totalIssues: number;
  };
}

export async function runLinter(
  code: string,
  language: string
): Promise<LintResult> {
  try {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          parserOptions: {
            ecmaFeatures: {
              jsx: true,
            },
          },
        },
        rules: {
          "no-unused-vars": "warn",
          "no-undef": "error",
          "no-console": "warn",
          "no-debugger": "error",
          "no-eval": "error",
          "no-implied-eval": "error",
          "no-var": "warn",
          "prefer-const": "warn",
          "eqeqeq": "warn",
          "no-throw-literal": "warn",
          "no-unreachable": "error",
          "no-constant-condition": "warn",
          "no-dupe-keys": "error",
          "no-duplicate-case": "error",
          "no-empty": "warn",
          "no-func-assign": "error",
          "no-irregular-whitespace": "warn",
          "no-sparse-arrays": "warn",
          "use-isnan": "error",
          "valid-typeof": "error",
          "curly": "warn",
          "no-alert": "warn",
          "no-caller": "error",
          "no-else-return": "warn",
          "no-empty-function": "warn",
          "no-eq-null": "warn",
          "no-floating-decimal": "warn",
          "no-multi-spaces": "warn",
          "no-new-func": "error",
          "no-new-wrappers": "warn",
          "no-redeclare": "error",
          "no-self-compare": "error",
          "no-sequences": "warn",
          "no-unused-expressions": "warn",
          "no-useless-concat": "warn",
          "no-with": "error",
        },
      },
    });

    const results = await eslint.lintText(code, {
      filePath: language === "typescript" ? "input.ts" : "input.js",
    });

    const issues: LintResult["issues"] = [];
    let errorCount = 0;
    let warningCount = 0;

    for (const result of results) {
      for (const message of result.messages) {
        const severity = message.severity === 2 ? "error" : "warning";
        issues.push({
          line: message.line,
          column: message.column,
          severity,
          message: message.message,
          rule: message.ruleId || "unknown",
        });

        if (severity === "error") {
          errorCount++;
        } else {
          warningCount++;
        }
      }
    }

    return {
      issues,
      summary: {
        errorCount,
        warningCount,
        totalIssues: issues.length,
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to run linter: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
