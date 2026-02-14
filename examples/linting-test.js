// Example code with linting issues

// Using var instead of const/let
var oldStyleVariable = 5;

// Undefined variable
function undefinedVarExample() {
  console.log(notDefined); // Using undefined variable
}

// Equality without type checking
function weakEquality(x) {
  if (x == 5) { // Should use ===
    return true;
  }
  return false;
}

// Empty block
function emptyBlock(x) {
  if (x > 0) {
    // Empty if block
  }
}

// Unnecessary else after return
function unnecessaryElse(x) {
  if (x > 0) {
    return 'positive';
  } else { // Unnecessary else
    return 'non-positive';
  }
}

// Multiple spaces
const value =    42; // Multiple spaces

// Debugger statement
function withDebugger() {
  debugger; // Should be removed in production
  return 'test';
}

// Console usage
function withConsole() {
  console.log('Debug message'); // Should be removed or use proper logging
  return true;
}

// Self comparison
function selfCompare(x) {
  if (x === x) { // Always true
    return true;
  }
}

// Duplicate keys
const obj = {
  key: 'value1',
  key: 'value2' // Duplicate key
};

// No curly braces
function noCurly(x) {
  if (x > 0)
    return 'positive'; // Should use curly braces
  return 'non-positive';
}

// Floating decimal
const number = .5; // Should be 0.5

// Empty function
function emptyFunc() {
  // Empty function body
}
