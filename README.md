# AI Static Analysis

A Model Context Protocol (MCP) server that provides static code analysis capabilities for JavaScript and TypeScript code. This tool can be used by Claude to analyze code quality, detect issues, and provide insights.

## Features

### 🔍 Four Powerful Analysis Tools

1. **Complexity Analysis** (`analyze_complexity`)
   - Calculates cyclomatic complexity for each function
   - Measures function length and nesting depth
   - Identifies functions that need refactoring
   - Provides average and maximum complexity metrics

2. **Dead Code Detection** (`find_dead_code`)
   - Finds unused variables and functions
   - Detects unreachable code segments
   - Identifies code after return statements
   - Highlights always-true/false conditions

3. **Linting** (`run_linter`)
   - ESLint integration with comprehensive rules
   - Checks for code style issues
   - Detects potential bugs
   - Enforces best practices

4. **Security Scanning** (`scan_security`)
   - Detects dangerous functions (eval, Function constructor)
   - Identifies XSS vulnerabilities (innerHTML, dangerouslySetInnerHTML)
   - Finds SQL injection patterns
   - Warns about hardcoded credentials

## Installation

```bash
npm install
npm run build
```

## Usage

### As an MCP Server

Configure your MCP client (e.g., Claude Desktop) to use this server:

```json
{
  "mcpServers": {
    "ai-static-analysis": {
      "command": "node",
      "args": ["/path/to/ai-static-analysis/dist/index.js"]
    }
  }
}
```

### Available Tools

#### 1. analyze_complexity

Analyze code complexity metrics:

```javascript
{
  "code": "function example() { if (x) { if (y) { return z; } } }",
  "language": "javascript"
}
```

#### 2. find_dead_code

Find unused variables and unreachable code:

```javascript
{
  "code": "const unused = 5; function test() { return 1; console.log('unreachable'); }"
}
```

#### 3. run_linter

Run ESLint on your code:

```javascript
{
  "code": "var x = 5; if (x = 6) { console.log(x); }",
  "language": "javascript"
}
```

#### 4. scan_security

Scan for security vulnerabilities:

```javascript
{
  "code": "eval(userInput); element.innerHTML = data;"
}
```

## Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run the server
npm start
```

## Architecture

```
src/
├── index.ts              # MCP server setup
└── analyzers/
    ├── complexity.ts     # Complexity analysis
    ├── deadcode.ts       # Dead code detection
    ├── linter.ts         # ESLint integration
    └── security.ts       # Security scanning
```

## Example Output

### Complexity Analysis
```json
{
  "summary": {
    "totalFunctions": 3,
    "averageComplexity": 5.67,
    "maxComplexity": 12,
    "highComplexityFunctions": 1
  },
  "functions": [
    {
      "name": "complexFunction",
      "line": 5,
      "complexity": 12,
      "length": 45,
      "maxNesting": 4,
      "warnings": [
        "High cyclomatic complexity (12). Consider refactoring."
      ]
    }
  ]
}
```

### Security Scan
```json
{
  "issues": [
    {
      "line": 10,
      "severity": "critical",
      "type": "eval-usage",
      "message": "Use of eval() is a critical security risk",
      "code": "eval(...)"
    }
  ],
  "summary": {
    "critical": 1,
    "high": 0,
    "medium": 0,
    "low": 0,
    "totalIssues": 1
  }
}
```

## License

MIT