# Usage Guide

This guide demonstrates how to use the AI Static Analysis MCP server with Claude.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   npm run build
   ```

2. **Configure Claude Desktop:**
   Add this to your Claude Desktop MCP settings file:
   
   **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

   ```json
   {
     "mcpServers": {
       "ai-static-analysis": {
         "command": "node",
         "args": ["/absolute/path/to/ai-static-analysis/dist/index.js"]
       }
     }
   }
   ```

3. **Restart Claude Desktop** to load the new MCP server.

## Using the Tools

Once configured, you can ask Claude to analyze code using natural language. Here are some examples:

### Example 1: Analyze Code Complexity

**You say:**
> Can you analyze the complexity of this function?
> ```javascript
> function processOrder(order, user, inventory) {
>   if (!order) return null;
>   if (!user) throw new Error('User required');
>   
>   let total = 0;
>   for (let item of order.items) {
>     if (!item.id) continue;
>     let stockItem = inventory.find(i => i.id === item.id);
>     if (!stockItem) continue;
>     
>     if (stockItem.quantity < item.quantity) {
>       if (stockItem.allowBackorder) {
>         console.log('Backordering');
>       } else {
>         throw new Error('Insufficient stock');
>       }
>     }
>     total += stockItem.price * item.quantity;
>   }
>   return total;
> }
> ```

**Claude will use `analyze_complexity` and respond with:**
- Cyclomatic complexity score
- Function length
- Maximum nesting depth
- Warnings if complexity is too high
- Suggestions for refactoring

### Example 2: Find Dead Code

**You say:**
> Check this code for unused variables and unreachable code:
> ```javascript
> const unusedVar = 42;
> 
> function test() {
>   return 'done';
>   console.log('This will never run');
> }
> 
> const activeVar = 100;
> console.log(activeVar);
> ```

**Claude will use `find_dead_code` and identify:**
- `unusedVar` is declared but never used
- Code after the return statement is unreachable

### Example 3: Lint Code

**You say:**
> Lint this code and tell me what needs to be fixed:
> ```javascript
> var x = 5;
> if (x == 6) {
>   console.log(x);
> }
> ```

**Claude will use `run_linter` and find:**
- Use `const` or `let` instead of `var`
- Use `===` instead of `==`
- Console statements should be removed

### Example 4: Security Scan

**You say:**
> Scan this code for security vulnerabilities:
> ```javascript
> function handleUserInput(input) {
>   eval(input);
>   document.getElementById('content').innerHTML = input;
> }
> 
> const apiKey = "sk-1234567890";
> ```

**Claude will use `scan_security` and warn about:**
- Critical: `eval()` usage (code injection risk)
- Medium: `innerHTML` usage (XSS vulnerability)
- High: Hardcoded API key

## Advanced Usage

### Combining Multiple Tools

You can ask Claude to perform comprehensive analysis:

> Analyze this entire module for complexity, dead code, linting issues, and security vulnerabilities.

Claude will automatically use all four tools and provide a comprehensive report.

### Iterative Improvement

After receiving analysis results, you can ask Claude to:
- Explain specific issues
- Suggest fixes
- Refactor problematic code
- Show best practice alternatives

Example workflow:
1. "Analyze this function for complexity" → Get complexity score
2. "How can I reduce the complexity?" → Get refactoring suggestions
3. "Rewrite it with lower complexity" → Get improved code
4. "Analyze the new version" → Verify improvements

## Testing Without Claude

You can test the analyzers directly using the included test script:

```bash
node test-analyzers.js
```

This will run all four analyzers on the example files in the `examples/` directory.

## Tool Reference

### analyze_complexity
- **Input:** JavaScript/TypeScript code
- **Output:** Complexity metrics, warnings, and suggestions
- **Best for:** Identifying overly complex functions that need refactoring

### find_dead_code
- **Input:** JavaScript/TypeScript code
- **Output:** List of unused variables/functions and unreachable code
- **Best for:** Cleaning up codebases and removing unnecessary code

### run_linter
- **Input:** JavaScript/TypeScript code
- **Output:** Style issues, potential bugs, and best practice violations
- **Best for:** Enforcing code quality standards

### scan_security
- **Input:** JavaScript/TypeScript code
- **Output:** Security vulnerabilities ranked by severity
- **Best for:** Identifying and fixing security issues before deployment

## Tips

1. **Provide Context:** Tell Claude what you're trying to achieve
2. **Be Specific:** Ask about particular concerns (e.g., "Is this function secure?")
3. **Iterate:** Use the feedback to improve your code, then analyze again
4. **Ask for Explanations:** Claude can explain why something is flagged as an issue
5. **Request Alternatives:** Ask Claude to show better ways to write the code

## Troubleshooting

### MCP Server Not Found
- Ensure the path in `claude_desktop_config.json` is absolute
- Check that `dist/index.js` exists (run `npm run build` if needed)
- Restart Claude Desktop

### Analysis Errors
- Verify the code syntax is valid JavaScript/TypeScript
- Check that the code doesn't contain unsupported ES features
- Try analyzing smaller code sections

### No Output
- Make sure you're asking Claude to analyze code (not just showing it code)
- Check the Claude Desktop logs for MCP connection issues
