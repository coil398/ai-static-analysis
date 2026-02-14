import * as acorn from "acorn";
import * as walk from "acorn-walk";

interface DeadCodeResult {
  unusedVariables: Array<{
    name: string;
    line: number;
    type: string;
  }>;
  unreachableCode: Array<{
    line: number;
    reason: string;
  }>;
  summary: {
    totalIssues: number;
    unusedCount: number;
    unreachableCount: number;
  };
}

export async function findDeadCode(code: string): Promise<DeadCodeResult> {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });

    const declared = new Map<string, { line: number; type: string }>();
    const used = new Set<string>();
    const unreachable: DeadCodeResult["unreachableCode"] = [];

    // First pass: collect all declarations
    walk.simple(ast as any, {
      VariableDeclarator(node: any) {
        if (node.id.type === "Identifier") {
          declared.set(node.id.name, {
            line: node.loc?.start.line || 0,
            type: "variable",
          });
        }
      },
      FunctionDeclaration(node: any) {
        if (node.id) {
          declared.set(node.id.name, {
            line: node.loc?.start.line || 0,
            type: "function",
          });
        }
      },
      ClassDeclaration(node: any) {
        if (node.id) {
          declared.set(node.id.name, {
            line: node.loc?.start.line || 0,
            type: "class",
          });
        }
      },
      ImportDeclaration(node: any) {
        node.specifiers.forEach((spec: any) => {
          if (spec.local) {
            declared.set(spec.local.name, {
              line: node.loc?.start.line || 0,
              type: "import",
            });
          }
        });
      },
    });

    // Second pass: track usage
    walk.simple(ast as any, {
      Identifier(node: any) {
        used.add(node.name);
      },
    });

    // Find unreachable code
    walk.ancestor(ast as any, {
      BlockStatement(node: any, ancestors: any[]) {
        const statements = node.body;
        let foundReturn = false;

        for (let i = 0; i < statements.length; i++) {
          const stmt = statements[i];

          if (foundReturn) {
            unreachable.push({
              line: stmt.loc?.start.line || 0,
              reason: "Code after return statement",
            });
          }

          if (
            stmt.type === "ReturnStatement" ||
            stmt.type === "ThrowStatement"
          ) {
            foundReturn = true;
          }
        }
      },
      IfStatement(node: any) {
        // Check for always-true or always-false conditions
        if (node.test.type === "Literal") {
          if (!node.test.value && node.consequent) {
            unreachable.push({
              line: node.consequent.loc?.start.line || 0,
              reason: "Condition is always false",
            });
          } else if (node.test.value && node.alternate) {
            unreachable.push({
              line: node.alternate.loc?.start.line || 0,
              reason: "Condition is always true",
            });
          }
        }
      },
    });

    // Find unused variables
    const unusedVariables: DeadCodeResult["unusedVariables"] = [];

    for (const [name, info] of declared.entries()) {
      // Ignore common patterns that might not be directly used
      if (
        !used.has(name) &&
        !name.startsWith("_") &&
        name !== "exports" &&
        name !== "module"
      ) {
        unusedVariables.push({
          name,
          line: info.line,
          type: info.type,
        });
      }
    }

    return {
      unusedVariables,
      unreachableCode: unreachable,
      summary: {
        totalIssues: unusedVariables.length + unreachable.length,
        unusedCount: unusedVariables.length,
        unreachableCount: unreachable.length,
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to find dead code: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
