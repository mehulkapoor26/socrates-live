import vm from "node:vm";

const EXECUTION_TIMEOUT_MS = 120;
const ISSUE_PRIORITY = new Map([
  ["syntax-error", 0],
  ["timeout-infinite-loop", 1],
  ["execution-timeout", 1],
  ["runtime-error", 2],
  ["division-by-zero", 3],
  ["possible-division-by-zero", 3],
  ["possible-infinite-loop", 4],
  ["logic-review", 5],
  ["possible-missing-semicolon", 5],
  ["passed-basic-run", 6],
  ["basic-run", 6],
  ["basic-static-check", 6]
]);

function makeIssue(language, status, lineNumber, issueType, evidence, hint) {
  return { language, status, lineNumber, issueType, evidence, hint };
}

function lineFromError(error) {
  const stack = String(error?.stack ?? "");
  const frame = stack.match(/(?:<submission>|evalmachine\.<anonymous>):(\d+)(?::\d+)?/);
  if (frame) return Number(frame[1]);
  const explicit = Number(error?.lineNumber);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return null;
}

function conciseEvidence(error) {
  const name = typeof error?.name === "string" ? error.name : "Error";
  const message = String(error?.message ?? error).split(/\r?\n/, 1)[0].trim();
  return `${name}: ${(message || "Execution failed").slice(0, 160)}`;
}

function obviousLoopLine(code) {
  const lines = code.split(/\r?\n/);
  const loopPattern = /\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/;
  const lineIndex = lines.findIndex((line) => loopPattern.test(line));
  return lineIndex < 0 ? null : lineIndex + 1;
}

function analyzeJavaScript(code, issues) {
  let script;
  try {
    script = new vm.Script(code, { filename: "<submission>" });
  } catch (error) {
    const lineNumber = lineFromError(error);
    issues.push(makeIssue("javascript", "failed", lineNumber, "syntax-error", conciseEvidence(error),
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
    const lineNumber = lineFromError(error) ?? (timedOut ? obviousLoopLine(code) : null);
    issues.push(makeIssue(
      "javascript", "failed", lineNumber,
      timedOut ? "execution-timeout" : "runtime-error",
      conciseEvidence(error),
      timedOut
        ? "Kaunsi loop condition ya recursive call execution ko rokne se chook rahi hai?"
        : "Is line par kaunsi value ya operation runtime mein unexpected ho sakta hai?"
    ));
  }
}

function hasExecutableContent(source) {
  let i = 0;
  let blockComment = false;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i += 2; continue; }
      i += 1;
      continue;
    }
    if (quote) {
      if (char === "\\") { i += 2; continue; }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; return true; }
    if (char === "/" && next === "*") { blockComment = true; i += 2; continue; }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "#") {
      const lineStart = source.lastIndexOf("\n", i - 1) + 1;
      const lineEnd = source.indexOf("\n", i);
      const fullLine = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim();
      if (/^#\s*(include|define|pragma|if|ifdef|ifndef|endif|else|elif|undef|error)\b/.test(fullLine)) return true;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (!/\s/.test(char)) return true;
    i += 1;
  }
  return false;
}

function inferLanguage(code) {
  if (/\b(public\s+class|System\.out\.|import\s+java\.)/.test(code)) return "java";
  if (/\b(def|elif|None|print\s*\(|while\s+True\s*:|for\s+\w+\s+in\s+)/.test(code) && !/\b(public\s+static|#include|int\s+main\s*\()/.test(code)) return "python";
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

function stripCommentsPreservingLines(source, language) {
  const chars = source.split("");
  let quote = null;
  let escaped = false;
  let blockComment = false;
  let lineComment = false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const next = chars[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      else if (char !== "\r") chars[i] = " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        chars[i] = chars[i + 1] = " ";
        i += 1;
        blockComment = false;
      } else if (char !== "\n" && char !== "\r") chars[i] = " ";
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "/" && next === "*") {
      chars[i] = chars[i + 1] = " ";
      i += 1;
      blockComment = true;
    } else if (language !== "python" && char === "/" && next === "/") {
      chars[i] = chars[i + 1] = " ";
      i += 1;
      lineComment = true;
    } else if (char === "#") {
      // Hash comments are used by Python; C-family preprocessor directives
      // are retained so that they are not mistaken for comments.
      const lineStart = source.lastIndexOf("\n", i - 1) + 1;
      const lineEnd = source.indexOf("\n", i);
      const text = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim();
      if (!/^#\s*(include|define|pragma|if|ifdef|ifndef|endif|else|elif|undef|error)\b/.test(text)) {
        lineComment = true;
        chars[i] = " ";
      }
    }
  }
  return chars.join("");
}

function analyzeStatic(code, language, issues) {
  const isCStyle = language === "java" || language === "c" || language === "cpp";
  stripCommentsPreservingLines(code, language).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const lineNumber = index + 1;
    if (!line || line.startsWith("//") || line.startsWith("#") || line.startsWith("/*") || line.startsWith("*")) return;

    if (/\bwhile\s*\(\s*(?:true|1)\s*\)|\bwhile\s+True\s*:|\bfor\s*\(\s*;\s*;\s*\)/.test(line)) {
      issues.push(makeIssue(language, "needs-review", lineNumber, "possible-infinite-loop", line,
        `Line ${lineNumber} par loop se bahar nikalne ki condition kab true hoti hai?`));
    }
    if (/(?:\/\/|\/|%)\s*(?:0+(?:\.0*)?|\.0+)(?![\w.])/.test(line)) {
      issues.push(makeIssue(language, "needs-review", lineNumber, "possible-division-by-zero", line,
        `Line ${lineNumber} par division ya remainder ka right-hand value zero ho sakta hai? Kaunsi condition is case ko clarify karegi?`));
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

const NUMERIC_LABEL = "(?:threshold|limit|maximum|max|min(?:imum)?|expected|target|count|size|iterations?|retries?|timeout|age|score|capacity|range)";
const NUMBER_PATTERN = /(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?%?(?![\w.])/gi;

function numericValues(text, { notes = false } = {}) {
  const source = String(text);
  const values = [];
  for (const match of source.matchAll(NUMBER_PATTERN)) {
    const token = match[0];
    const start = match.index;
    const before = source.slice(Math.max(0, start - 70), start);
    // Numbered list markers and explicit source line references are usually
    // formatting metadata, rather than values from the student's notes.
    const afterToken = source.slice(start + token.length);
    if (notes && /^\s*[.)]\s/.test(afterToken)) continue;
    if (notes && /\bline\s*(?:number\s*)?$/i.test(before.slice(-24))) continue;

    const valueText = token.replaceAll(",", "").replace(/%$/, "");
    const value = Number(valueText);
    if (!Number.isFinite(value)) continue;
    const prefix = source.slice(Math.max(source.lastIndexOf("\n", start - 1) + 1, start - 70), start);
    const suffix = source.slice(start + token.length, Math.min(source.indexOf("\n", start) < 0 ? source.length : source.indexOf("\n", start), start + token.length + 35));
    const labels = `${prefix} ${suffix}`.match(new RegExp(NUMERIC_LABEL, "gi")) ?? [];
    const label = labels.at(-1)?.toLowerCase().replace(/\s+/g, " ") ?? null;
    values.push({ token, value, label });
  }
  return values;
}

function findMismatchNote(notebookNotes, code) {
  const noteText = String(notebookNotes ?? "");
  if (!noteText.trim()) return null;

  const notes = numericValues(noteText, { notes: true });
  if (!notes.length) return null;
  const language = inferLanguage(String(code));
  const source = stripCommentsPreservingLines(String(code), language);
  const codeNumbers = numericValues(source);
  const codeValues = new Set(codeNumbers.map(({ value }) => value));
  const differences = [];
  const handled = new Set();

  // Compare named values (such as a threshold or limit) by their nearby label
  // first; a coincidental occurrence of the same number elsewhere is not a match.
  for (const note of notes) {
    if (!note.label) continue;
    const codeMatch = codeNumbers.find((candidate) => candidate.label === note.label);
    handled.add(note);
    if (codeMatch && codeMatch.value !== note.value) {
      differences.push(`the ${note.label} is ${note.token} in the notes but ${codeMatch.token} in the code`);
    } else if (!codeMatch && !codeValues.has(note.value)) {
      differences.push(`${note.label} value ${note.token} from the notes was not found in the code`);
    }
  }

  for (const note of notes) {
    if (handled.has(note) || codeValues.has(note.value)) continue;
    differences.push(`value ${note.token} from the notes was not found in the code`);
  }

  const uniqueDifferences = [...new Set(differences)].slice(0, 3);
  if (!uniqueDifferences.length) return null;
  return `The notes and code differ: ${uniqueDifferences.join("; ")}. Which value or condition should you verify against your notes?`;
}

/** Analyze source code and return a stable result shape for API consumers. */
export function analyzeSubmission({ code = "", notebookNotes = "" } = {}) {
  const source = String(code);
  const issues = [];
  const language = inferLanguage(source);
  if (!hasExecutableContent(source)) {
    issues.push(makeIssue(language, "empty-or-comment-only", 1, "logic-review", "No executable code was found.",
      "What part of the problem would be a useful place to start exploring?"));
  } else if (language === "javascript") analyzeJavaScript(source, issues);
  else analyzeStatic(source, language, issues);
  const prioritizedIssues = issues
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((a, b) => (ISSUE_PRIORITY.get(a.item.issueType) ?? 5) - (ISSUE_PRIORITY.get(b.item.issueType) ?? 5) || a.originalIndex - b.originalIndex)
    .map(({ item }) => item);
  return { issues: prioritizedIssues, mismatchNote: findMismatchNote(notebookNotes, source) };
}
