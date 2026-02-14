// Example code with dead code issues

// Unused variable
const unusedVariable = 42;

// Unused function
function unusedFunction() {
  return 'never called';
}

// Function with unreachable code
function earlyReturn(x) {
  if (x > 0) {
    return 'positive';
  }
  return 'non-positive';
  console.log('This line is unreachable'); // Dead code
}

// Always-false condition
function alwaysFalse(x) {
  if (false) {
    console.log('This will never execute'); // Dead code
  }
  return x;
}

// Always-true condition
function alwaysTrue(x) {
  if (true) {
    return 'always';
  } else {
    console.log('This will never execute'); // Dead code
  }
}

// Unreachable code after throw
function throwExample() {
  throw new Error('error');
  console.log('Never reached'); // Dead code
}

// Used variable and function (not dead code)
const activeVariable = 100;

function activeFunction(x) {
  return x * 2;
}

const result = activeFunction(activeVariable);
console.log(result);

// Unused import (if this were a module)
const unusedImport = 'not used anywhere';

// Variable declared but only assigned, never read
let onlyAssigned = 5;
onlyAssigned = 10;
onlyAssigned = 15;
