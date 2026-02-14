import * as acorn from "acorn";
import * as walk from "acorn-walk";

interface SecurityIssue {
  line: number;
  severity: "critical" | "high" | "medium" | "low";
  type: string;
  message: string;
  code?: string;
}

interface SecurityResult {
  issues: SecurityIssue[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    totalIssues: number;
  };
}

export async function scanSecurityIssues(
  code: string
): Promise<SecurityResult> {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });

    const issues: SecurityIssue[] = [];

    walk.simple(ast as any, {
      CallExpression(node: any) {
        // Check for eval usage
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "eval"
        ) {
          issues.push({
            line: node.loc?.start.line || 0,
            severity: "critical",
            type: "eval-usage",
            message: "Use of eval() is a critical security risk",
            code: "eval(...)",
          });
        }

        // Check for Function constructor
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Function"
        ) {
          issues.push({
            line: node.loc?.start.line || 0,
            severity: "high",
            type: "function-constructor",
            message: "Function constructor can execute arbitrary code",
            code: "new Function(...)",
          });
        }

        // Check for setTimeout/setInterval with string
        if (
          node.callee.type === "Identifier" &&
          (node.callee.name === "setTimeout" ||
            node.callee.name === "setInterval")
        ) {
          if (node.arguments[0] && node.arguments[0].type === "Literal") {
            issues.push({
              line: node.loc?.start.line || 0,
              severity: "high",
              type: "string-to-code",
              message: `${node.callee.name} with string argument acts like eval`,
              code: `${node.callee.name}("code", ...)`,
            });
          }
        }

        // Check for document.write
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "document" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "write"
        ) {
          issues.push({
            line: node.loc?.start.line || 0,
            severity: "medium",
            type: "xss-risk",
            message:
              "document.write() can introduce XSS vulnerabilities",
            code: "document.write(...)",
          });
        }
      },

      AssignmentExpression(node: any) {
        // Check for innerHTML usage
        if (
          node.left.type === "MemberExpression" &&
          node.left.property.type === "Identifier" &&
          node.left.property.name === "innerHTML"
        ) {
          issues.push({
            line: node.loc?.start.line || 0,
            severity: "medium",
            type: "xss-risk",
            message:
              "innerHTML can introduce XSS vulnerabilities if used with untrusted data",
            code: ".innerHTML = ...",
          });
        }
      },

      MemberExpression(node: any) {
        // Check for dangerouslySetInnerHTML (React)
        if (
          node.property.type === "Identifier" &&
          node.property.name === "dangerouslySetInnerHTML"
        ) {
          issues.push({
            line: node.loc?.start.line || 0,
            severity: "high",
            type: "xss-risk",
            message:
              "dangerouslySetInnerHTML can introduce XSS vulnerabilities",
            code: "dangerouslySetInnerHTML",
          });
        }
      },

      Literal(node: any) {
        // Check for SQL-like patterns in strings
        if (typeof node.value === "string") {
          const sqlPatterns = [
            /SELECT\s+.*\s+FROM\s+/i,
            /INSERT\s+INTO\s+/i,
            /UPDATE\s+.*\s+SET\s+/i,
            /DELETE\s+FROM\s+/i,
            /DROP\s+TABLE\s+/i,
          ];

          for (const pattern of sqlPatterns) {
            if (pattern.test(node.value)) {
              issues.push({
                line: node.loc?.start.line || 0,
                severity: "medium",
                type: "sql-injection-risk",
                message:
                  "Potential SQL injection risk detected. Use parameterized queries.",
                code: node.value.substring(0, 50) + "...",
              });
              break;
            }
          }

          // Check for hardcoded credentials patterns
          const credentialPatterns = [
            /password\s*[:=]\s*['"][^'"]+['"]/i,
            /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,
            /secret\s*[:=]\s*['"][^'"]+['"]/i,
            /token\s*[:=]\s*['"][^'"]+['"]/i,
          ];

          for (const pattern of credentialPatterns) {
            if (pattern.test(node.value)) {
              issues.push({
                line: node.loc?.start.line || 0,
                severity: "high",
                type: "hardcoded-credentials",
                message:
                  "Potential hardcoded credentials detected. Use environment variables.",
              });
              break;
            }
          }
        }
      },
    });

    // Calculate summary
    const summary = {
      critical: issues.filter((i) => i.severity === "critical").length,
      high: issues.filter((i) => i.severity === "high").length,
      medium: issues.filter((i) => i.severity === "medium").length,
      low: issues.filter((i) => i.severity === "low").length,
      totalIssues: issues.length,
    };

    return {
      issues,
      summary,
    };
  } catch (error) {
    throw new Error(
      `Failed to scan for security issues: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
