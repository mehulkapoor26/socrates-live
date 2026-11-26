import vm from "node:vm";

const EXECUTION_TIMEOUT_MS = 120;

function makeIssue(language, status, lineNumber, issueType, evidence, hint) {
  return { language, status, lineNumber, issueType, evidence, hint };
}

function lineFromError(error, code) {
  const stack = String(error?.stack ?? "");
  // Script filenames are controlled, so the first matching frame is the
  // submission location for both parse-time and runtime errors.
  const frame = stack.match(/<submission>:(\d+)(?::\d+)?/);
  if (frame) return Number(frame[1]);
  const explicit = Number(error?.lineNumber);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  // Some Node/V8 syntax errors omit a location. Do not fabricate one.
  return null;
}

function analyzeJavaScript(code, issues) {
  let script;
  try {
    script = new vm.Script(code, { filename: "<submission>" });
  } catch (error) {
    const lineNumber = lineFromError(error, code);
    issues.push(makeIssue("javascript", "failed", lineNumber, "syntax-error", String(error.message),
      "Parser kis token ya expression ka intezar kar raha hai? Us line ke aas-paas ke brackets aur separators dekho."));
    return;
  }

  try {
    const sandbox = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: "afterEvaluate"
    });
    script.runInContext(sandbox, { timeout: EXECUTION_TIMEOUT_MS });
    issues.push(makeIssue("javascript", "passed-basic-run", 1, "basic-run", "Syntax is valid; execution completed within the time limit.",
      "Run ek chhote representative input ke saath bhi karke dekho—kya output tumhari expectation se match karta hai?"));
  } catch (error) {
    const timedOut = error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    const lineNumber = lineFromError(error, code);
    issues.push(makeIssue(
      "javascript", "failed", lineNumber,
      timedOut ? "execution-timeout" : "runtime-error",
      String(error.message),
      timedOut
        ? "Kaunsi loop condition ya recursive call execution ko rokne se chook rahi hai?"
        : "Is line par kaunsi value ya operation runtime mein unexpected ho sakta hai?"
    ));
  }
}

function inferLanguage(code) {
  if (/\b(public\s+class|System\.out\.|import\s+java\.)/.test(code)) return "java";
  if (/\b(def|elif|None|print\s*\()/.test(code) && !/\b(public\s+static|#include|int\s+main\s*\()/.test(code)) return "python";
  if (/#include\s*<[^>]+>|\bstd::|\bint\s+main\s*\(/.test(code)) {
    return /\bstd::|#include\s*<iostream>|\busing\s+namespace\s+std/.test(code) ? "cpp" : "c";
  }
  return "javascript";
}

function needsSemicolon(line) {
  if (!line || /[;{}:]$/.test(line) || /^(#|\/\/|\/\*|\*|\*\/)/.test(line)) return false;
  if (/^(if|else|for|while|switch|case|default|try|catch|finally|do|class|interface|enum|package|import|public\s+class)\b/.test(line)) return false;
  if (/^(public|private|protected)\s+[^=]+\([^;]*\)\s*(throws\b[^{}]+)?$/.test(line)) return false; // method declaration
  if (/^(public|private|protected)\s+(static\s+)?(final\s+)?[\w<>\[\],.?]+\s+\w+\s*\([^;]*\)$/.test(line)) return false;
  return /^(return|throw|break|continue|\w[\w\s<>\[\].,]*\s*=|(?:const|let|var|int|char|float|double|long|short|bool|boolean|String|auto|size_t)\b|\w+\s*\([^;]*\))/.test(line);
}

function analyzeStatic(code, language, issues) {
  const isCStyle = language === "java" || language === "c" || language === "cpp";
  code.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const lineNumber = index + 1;
    if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("/*") || line.startsWith("*")) return;

    if (/\bwhile\s*\(\s*true\s*\)|\bwhile\s+True\s*:|\bfor\s*\(\s*;\s*;\s*\)/.test(line)) {
      issues.push(makeIssue(language, "needs-review", lineNumber, "possible-infinite-loop", line,
        `Line ${lineNumber} par loop se bahar nikalne ki condition kab true hoti hai?`));
    }
    if (/\/\s*0(?:\.0+)?(?:\b|$)/.test(line)) {
      issues.push(makeIssue(language, "needs-review", lineNumber, "possible-division-by-zero", line,
        `Line ${lineNumber} par denominator zero ho sakta hai? Is division se pehle kaunsi check relevant hai?`));
    }
    if (isCStyle && needsSemicolon(line)) {
      issues.push(makeIssue(language, "needs-review", lineNumber, "possible-missing-semicolon", line,
        `Line ${lineNumber} par statement ka end marker missing toh nahi? Dekho yeh statement block ke andar kaise close hota hai.`));
    }
  });
  if (issues.length === 0) {
    issues.push(makeIssue(language, "passed-basic-run", 1, "basic-static-check", "No targeted line-level pattern was detected.",
      "Ek chhote input par dry run karke dekho—kya har branch aur loop expected tareeke se behave karta hai?"));
  }
}

function numericValues(text) {
  const tokens = String(text).match(/(?<![\w.])(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?![\w.])/gi) ?? [];
  return tokens.map((token) => ({ token, value: Number(token) })).filter(({ value }) => Number.isFinite(value));
}

function findMismatchNote(notebookNotes, code) {
  const notes = numericValues(notebookNotes);
  if (!notes.length) return null;
  const codeValues = new Set(numericValues(code).map(({ value }) => value));
  const missing = [...new Map(notes.filter(({ value }) => !codeValues.has(value)).map((item) => [item.value, item])).values()];
  if (!missing.length) return null;
  const shown = missing.map(({ token }) => `“${token}”`).join(", ");
  return `Notebook notes mein ${shown} value${missing.length > 1 ? "s" : ""} hai, par code mein yeh numeric value${missing.length > 1 ? "s" : ""} nahi mili. Kya inka role ya context code mein account hua hai?`;
}

/** Analyze source code and return a stable result shape for API consumers. */
export function analyzeSubmission({ code = "", notebookNotes = "" } = {}) {
  const source = String(code);
  const issues = [];
  const language = inferLanguage(source);
  if (language === "javascript") analyzeJavaScript(source, issues);
  else analyzeStatic(source, language, issues);
  return { issues, mismatchNote: findMismatchNote(notebookNotes, source) };
}
