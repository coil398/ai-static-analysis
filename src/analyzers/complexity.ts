import * as acorn from "acorn";
import * as walk from "acorn-walk";

interface ComplexityResult {
  summary: {
    totalFunctions: number;
    averageComplexity: number;
    maxComplexity: number;
    highComplexityFunctions: number;
  };
  functions: Array<{
    name: string;
    line: number;
    complexity: number;
    length: number;
    maxNesting: number;
    warnings: string[];
  }>;
}

export async function analyzeCodeComplexity(
  code: string,
  language: string
): Promise<ComplexityResult> {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });

    const functions: ComplexityResult["functions"] = [];
    let currentFunction: any = null;
    let complexity = 0;
    let nestingDepth = 0;
    let maxNesting = 0;

    walk.ancestor(ast as any, {
      FunctionDeclaration(node: any, ancestors: any[]) {
        const name = node.id?.name || "anonymous";
        currentFunction = {
          name,
          line: node.loc?.start.line || 0,
          complexity: 1,
          length: 0,
          maxNesting: 0,
          warnings: [],
        };

        // Calculate function length
        if (node.loc) {
          currentFunction.length = node.loc.end.line - node.loc.start.line + 1;
        }

        analyzeFunctionComplexity(node, currentFunction);
        functions.push(currentFunction);
      },
      FunctionExpression(node: any, ancestors: any[]) {
        const name =
          ancestors[ancestors.length - 2]?.id?.name || "anonymous function";
        currentFunction = {
          name,
          line: node.loc?.start.line || 0,
          complexity: 1,
          length: 0,
          maxNesting: 0,
          warnings: [],
        };

        if (node.loc) {
          currentFunction.length = node.loc.end.line - node.loc.start.line + 1;
        }

        analyzeFunctionComplexity(node, currentFunction);
        functions.push(currentFunction);
      },
      ArrowFunctionExpression(node: any, ancestors: any[]) {
        const name =
          ancestors[ancestors.length - 2]?.id?.name || "arrow function";
        currentFunction = {
          name,
          line: node.loc?.start.line || 0,
          complexity: 1,
          length: 0,
          maxNesting: 0,
          warnings: [],
        };

        if (node.loc) {
          currentFunction.length = node.loc.end.line - node.loc.start.line + 1;
        }

        analyzeFunctionComplexity(node, currentFunction);
        functions.push(currentFunction);
      },
    });

    // Calculate summary
    const totalComplexity = functions.reduce((sum, f) => sum + f.complexity, 0);
    const avgComplexity =
      functions.length > 0 ? totalComplexity / functions.length : 0;
    const maxComplexity = functions.reduce(
      (max, f) => Math.max(max, f.complexity),
      0
    );
    const highComplexityFunctions = functions.filter(
      (f) => f.complexity > 10
    ).length;

    return {
      summary: {
        totalFunctions: functions.length,
        averageComplexity: Math.round(avgComplexity * 100) / 100,
        maxComplexity,
        highComplexityFunctions,
      },
      functions,
    };
  } catch (error) {
    throw new Error(
      `Failed to analyze complexity: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function analyzeFunctionComplexity(node: any, funcData: any) {
  let complexity = 1;
  let maxNesting = 0;
  let currentNesting = 0;

  walk.recursive(
    node,
    { depth: 0 },
    {
      IfStatement(node: any, state: any) {
        complexity++;
        currentNesting = state.depth;
        maxNesting = Math.max(maxNesting, currentNesting);
        walk.recursive(node.consequent, { depth: state.depth + 1 }, this);
        if (node.alternate) {
          walk.recursive(node.alternate, { depth: state.depth + 1 }, this);
        }
      },
      ForStatement(node: any, state: any) {
        complexity++;
        currentNesting = state.depth;
        maxNesting = Math.max(maxNesting, currentNesting);
        walk.recursive(node.body, { depth: state.depth + 1 }, this);
      },
      WhileStatement(node: any, state: any) {
        complexity++;
        currentNesting = state.depth;
        maxNesting = Math.max(maxNesting, currentNesting);
        walk.recursive(node.body, { depth: state.depth + 1 }, this);
      },
      DoWhileStatement(node: any, state: any) {
        complexity++;
        currentNesting = state.depth;
        maxNesting = Math.max(maxNesting, currentNesting);
        walk.recursive(node.body, { depth: state.depth + 1 }, this);
      },
      ForInStatement(node: any, state: any) {
        complexity++;
        walk.recursive(node.body, { depth: state.depth + 1 }, this);
      },
      ForOfStatement(node: any, state: any) {
        complexity++;
        walk.recursive(node.body, { depth: state.depth + 1 }, this);
      },
      ConditionalExpression() {
        complexity++;
      },
      LogicalExpression(node: any) {
        if (node.operator === "&&" || node.operator === "||") {
          complexity++;
        }
      },
      SwitchCase() {
        complexity++;
      },
      CatchClause() {
        complexity++;
      },
    }
  );

  funcData.complexity = complexity;
  funcData.maxNesting = maxNesting;

  // Add warnings
  if (complexity > 10) {
    funcData.warnings.push(
      `High cyclomatic complexity (${complexity}). Consider refactoring.`
    );
  }
  if (funcData.length > 50) {
    funcData.warnings.push(
      `Function is too long (${funcData.length} lines). Consider breaking it down.`
    );
  }
  if (maxNesting > 4) {
    funcData.warnings.push(
      `Deep nesting detected (${maxNesting} levels). Consider extracting nested logic.`
    );
  }
}
