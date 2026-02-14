#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { analyzeCodeComplexity } from "./analyzers/complexity.js";
import { findDeadCode } from "./analyzers/deadcode.js";
import { runLinter } from "./analyzers/linter.js";
import { scanSecurityIssues } from "./analyzers/security.js";

const server = new Server(
  {
    name: "ai-static-analysis",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "analyze_complexity",
        description:
          "Analyze code complexity metrics including cyclomatic complexity, function length, and nesting depth",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The JavaScript/TypeScript code to analyze",
            },
            language: {
              type: "string",
              enum: ["javascript", "typescript"],
              description: "The programming language of the code",
              default: "javascript",
            },
          },
          required: ["code"],
        },
      },
      {
        name: "find_dead_code",
        description:
          "Detect unused variables, unreachable code, and dead code paths",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The JavaScript/TypeScript code to analyze",
            },
          },
          required: ["code"],
        },
      },
      {
        name: "run_linter",
        description:
          "Run ESLint to check for code style issues, potential bugs, and best practice violations",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The JavaScript/TypeScript code to lint",
            },
            language: {
              type: "string",
              enum: ["javascript", "typescript"],
              description: "The programming language of the code",
              default: "javascript",
            },
          },
          required: ["code"],
        },
      },
      {
        name: "scan_security",
        description:
          "Scan code for common security vulnerabilities like XSS, SQL injection patterns, eval usage, and unsafe functions",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The JavaScript/TypeScript code to scan",
            },
          },
          required: ["code"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    switch (name) {
      case "analyze_complexity": {
        const result = await analyzeCodeComplexity(
          args.code as string,
          (args.language as string) || "javascript"
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "find_dead_code": {
        const result = await findDeadCode(args.code as string);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "run_linter": {
        const result = await runLinter(
          args.code as string,
          (args.language as string) || "javascript"
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "scan_security": {
        const result = await scanSecurityIssues(args.code as string);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AI Static Analysis MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
