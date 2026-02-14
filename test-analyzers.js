#!/usr/bin/env node
/**
 * Test script to manually verify the static analysis tools
 * This script tests each analyzer independently without the MCP layer
 */

import { analyzeCodeComplexity } from './dist/analyzers/complexity.js';
import { findDeadCode } from './dist/analyzers/deadcode.js';
import { runLinter } from './dist/analyzers/linter.js';
import { scanSecurityIssues } from './dist/analyzers/security.js';
import { readFileSync } from 'fs';

console.log('='.repeat(80));
console.log('AI Static Analysis Test Suite');
console.log('='.repeat(80));
console.log();

async function testComplexity() {
  console.log('📊 Testing Complexity Analyzer...');
  console.log('-'.repeat(80));
  
  const code = readFileSync('./examples/complexity-test.js', 'utf-8');
  const result = await analyzeCodeComplexity(code, 'javascript');
  
  console.log('Summary:', JSON.stringify(result.summary, null, 2));
  console.log('\nFunctions with high complexity:');
  result.functions
    .filter(f => f.complexity > 5)
    .forEach(f => {
      console.log(`  - ${f.name} (line ${f.line}): complexity=${f.complexity}, length=${f.length} lines, maxNesting=${f.maxNesting}`);
      if (f.warnings.length > 0) {
        f.warnings.forEach(w => console.log(`    ⚠️  ${w}`));
      }
    });
  console.log('✅ Complexity analysis completed\n');
}

async function testDeadCode() {
  console.log('🔍 Testing Dead Code Detector...');
  console.log('-'.repeat(80));
  
  const code = readFileSync('./examples/deadcode-test.js', 'utf-8');
  const result = await findDeadCode(code);
  
  console.log('Summary:', JSON.stringify(result.summary, null, 2));
  
  if (result.unusedVariables.length > 0) {
    console.log('\nUnused variables/functions:');
    result.unusedVariables.forEach(v => {
      console.log(`  - ${v.name} (${v.type}) at line ${v.line}`);
    });
  }
  
  if (result.unreachableCode.length > 0) {
    console.log('\nUnreachable code:');
    result.unreachableCode.forEach(u => {
      console.log(`  - Line ${u.line}: ${u.reason}`);
    });
  }
  
  console.log('✅ Dead code detection completed\n');
}

async function testLinter() {
  console.log('📝 Testing Linter...');
  console.log('-'.repeat(80));
  
  const code = readFileSync('./examples/linting-test.js', 'utf-8');
  const result = await runLinter(code, 'javascript');
  
  console.log('Summary:', JSON.stringify(result.summary, null, 2));
  
  if (result.issues.length > 0) {
    console.log('\nTop 10 issues:');
    result.issues.slice(0, 10).forEach(issue => {
      const emoji = issue.severity === 'error' ? '❌' : '⚠️';
      console.log(`  ${emoji} Line ${issue.line}:${issue.column} [${issue.rule}] ${issue.message}`);
    });
    
    if (result.issues.length > 10) {
      console.log(`  ... and ${result.issues.length - 10} more issues`);
    }
  }
  
  console.log('✅ Linting completed\n');
}

async function testSecurity() {
  console.log('🔒 Testing Security Scanner...');
  console.log('-'.repeat(80));
  
  const code = readFileSync('./examples/security-test.js', 'utf-8');
  const result = await scanSecurityIssues(code);
  
  console.log('Summary:', JSON.stringify(result.summary, null, 2));
  
  if (result.issues.length > 0) {
    console.log('\nSecurity issues found:');
    
    const bySeverity = {
      critical: result.issues.filter(i => i.severity === 'critical'),
      high: result.issues.filter(i => i.severity === 'high'),
      medium: result.issues.filter(i => i.severity === 'medium'),
      low: result.issues.filter(i => i.severity === 'low'),
    };
    
    for (const [severity, issues] of Object.entries(bySeverity)) {
      if (issues.length > 0) {
        console.log(`\n  ${severity.toUpperCase()}:`);
        issues.forEach(issue => {
          console.log(`    🚨 Line ${issue.line} [${issue.type}]: ${issue.message}`);
          if (issue.code) {
            console.log(`       Code: ${issue.code}`);
          }
        });
      }
    }
  }
  
  console.log('✅ Security scanning completed\n');
}

async function runAllTests() {
  try {
    await testComplexity();
    await testDeadCode();
    await testLinter();
    await testSecurity();
    
    console.log('='.repeat(80));
    console.log('✅ All tests completed successfully!');
    console.log('='.repeat(80));
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

runAllTests();
