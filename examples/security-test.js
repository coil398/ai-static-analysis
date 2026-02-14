// Example code with security vulnerabilities

// CRITICAL: eval usage
function dangerousEval(userInput) {
  eval(userInput); // Critical security risk!
}

// HIGH: Function constructor
function functionConstructor(code) {
  const fn = new Function('x', code); // Can execute arbitrary code
  return fn;
}

// HIGH: setTimeout with string
function timeoutString() {
  setTimeout("console.log('dangerous')", 1000); // Acts like eval
}

// MEDIUM: innerHTML usage
function updateDOM(userContent) {
  document.getElementById('content').innerHTML = userContent; // XSS risk
}

// MEDIUM: document.write
function writeToDocument(data) {
  document.write(data); // XSS risk
}

// HIGH: dangerouslySetInnerHTML (React pattern)
function ReactComponent(props) {
  return {
    dangerouslySetInnerHTML: { __html: props.userContent } // XSS risk
  };
}

// MEDIUM: SQL injection pattern
function queryDatabase(userId) {
  const query = "SELECT * FROM users WHERE id = " + userId; // SQL injection risk
  return query;
}

// HIGH: Hardcoded credentials
const config = {
  password: "mySecretPassword123", // Hardcoded password
  apiKey: "sk-1234567890abcdef", // Hardcoded API key
  secret: "my-secret-token" // Hardcoded secret
};

// MEDIUM: More SQL patterns
function deleteUser(username) {
  const sql = "DELETE FROM users WHERE username = '" + username + "'"; // SQL injection
  return sql;
}

function updateUser(id, email) {
  const sql = "UPDATE users SET email = '" + email + "' WHERE id = " + id; // SQL injection
  return sql;
}

// CRITICAL: Multiple security issues in one function
function extremelyDangerous(userInput, userId) {
  // Eval
  eval(userInput);
  
  // SQL injection
  const query = "SELECT * FROM data WHERE user_id = " + userId;
  
  // XSS
  document.body.innerHTML = userInput;
  
  // Hardcoded credentials
  const key = "api_key_12345";
  
  return query;
}

// SAFER ALTERNATIVES (for reference):
function saferAlternatives() {
  // Instead of eval, use JSON.parse for data
  // Instead of innerHTML, use textContent or createElement
  // Instead of string concatenation in SQL, use parameterized queries
  // Instead of hardcoded credentials, use environment variables
  
  const safeData = JSON.parse('{"key": "value"}');
  const element = document.createElement('div');
  element.textContent = 'safe content';
  
  // Parameterized query (pseudocode)
  // db.query('SELECT * FROM users WHERE id = ?', [userId]);
  
  // Environment variables
  // const apiKey = process.env.API_KEY;
}
