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

function loopDetails(line) {
  const pythonWhile = line.match(/^\s*while\s+(.+?)\s*:\s*(?:#.*)?$/);
  const cWhile = line.match(/\bwhile\s*\(([^)]*)\)/);
  const forLoop = line.match(/\bfor\s*\(([^)]*)\)/);
  const condition = pythonWhile?.[1] ?? cWhile?.[1] ?? null;
  const forParts = forLoop?.[1].split(";") ?? null;
  if (!condition && !forParts) return null;

  if (condition && /^(?:true|1)$/i.test(condition.trim())) {
    return { unconditional: true, control: null };
  }
  if (forParts && forParts.length === 3 && !forParts[1].trim() && !forParts[2].trim()) {
    return { unconditional: true, control: null };
  }

  const controlSource = forParts ? `${forParts[0]} ${forParts[1]}` : condition;
  const control = controlSource?.match(/\b([A-Za-z_$][\w$]*)\s*(?:<=|>=|<|>|!=|==)/)?.[1]
    ?? controlSource?.match(/(?:<=|>=|<|>|!=|==)\s*\b([A-Za-z_$][\w$]*)/)?.[1]
    ?? (forParts ? forParts[0].match(/\b([A-Za-z_$][\w$]*)\s*=/)?.[1] : null);
  if (!control) return null;

  const updateChangesControl = forParts?.[2] && new RegExp(`\\b${control}\\b\\s*(?:\\+\\+|--|[+\\-*/%]=)|(?:\\+\\+|--)\\s*\\b${control}\\b`).test(forParts[2]);
  return { unconditional: false, control, updateChangesControl: Boolean(updateChangesControl) };
}

function controlVariableChanges(body, control) {
  if (!control) return false;
  const name = control.replace(/[$]/g, "\\$");
  return new RegExp(`(?:\\b${name}\\b\\s*(?:\\+\\+|--|[+\\-*/%]=|(?<![=!<>])=(?!=))|(?:\\+\\+|--)\\s*\\b${name}\\b)`).test(body);
}

/**
 * Performs bounded, static loop checks only; submitted code is never run here.
 * The step budget counts source lines inspected, so even unusually large input
 * cannot make this helper scan indefinitely.
 */
export function runSafeCodeChecks(code, options = {}) {
  const requestedLimit = Number(options?.maxIterations ?? 5000);
  const maxIterations = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 5000;
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const lines = stripCommentsPreservingLines(source, language).split(/\r?\n/);
  const riskyLines = [];
  let iterationsUsed = 0;
  let lineIndex = 0;

  while (lineIndex < lines.length && iterationsUsed < maxIterations) {
    const currentIndex = lineIndex;
    const line = lines[lineIndex];
    iterationsUsed += 1;
    lineIndex += 1;
    const details = loopDetails(line);
    if (!details) continue;

    let body = "";
    let consumedThrough = currentIndex;
    const trimmed = line.trim();
    const isPythonLoop = /^while\s+.+:\s*$/.test(trimmed);
    if (isPythonLoop) {
      const indent = line.length - line.trimStart().length;
      for (let bodyIndex = currentIndex + 1; bodyIndex < lines.length && iterationsUsed < maxIterations; bodyIndex += 1) {
        iterationsUsed += 1;
        const bodyLine = lines[bodyIndex];
        if (bodyLine.trim() && bodyLine.length - bodyLine.trimStart().length <= indent) break;
        body += `${bodyLine}\n`;
        consumedThrough = bodyIndex;
      }
    } else {
      const openBrace = line.indexOf("{");
      if (openBrace >= 0) {
        let depth = 0;
        for (let bodyIndex = currentIndex; bodyIndex < lines.length && iterationsUsed < maxIterations; bodyIndex += 1) {
          if (bodyIndex > currentIndex) iterationsUsed += 1;
          const bodyLine = lines[bodyIndex];
          body += `${bodyLine}\n`;
          for (const char of bodyLine) {
            if (char === "{") depth += 1;
            else if (char === "}") depth -= 1;
          }
          consumedThrough = bodyIndex;
          if (depth <= 0) break;
        }
      } else if (currentIndex + 1 < lines.length && iterationsUsed < maxIterations) {
        iterationsUsed += 1;
        body = lines[currentIndex + 1];
        consumedThrough = currentIndex + 1;
      }
    }

    const noProgress = details.unconditional || (!details.updateChangesControl && !controlVariableChanges(body, details.control));
    if (noProgress) {
      const reason = details.unconditional
        ? "Loop uses an unconditional condition or omits its condition."
        : `Control variable '${details.control}' is not changed in the loop body.`;
      riskyLines.push({ lineNumber: currentIndex + 1, reason });
    }
    lineIndex = Math.max(lineIndex, consumedThrough + 1);
  }

  const capped = lineIndex < lines.length;
  return {
    safe: riskyLines.length === 0 && !capped,
    iterationsUsed,
    maxIterations,
    capped,
    riskyLines
  };
}

/**
 * Inspects common source structures with lightweight, comment-aware line
 * patterns. This is intentionally not a parser and never executes the code.
 */
export function inspectCodeStructure(code) {
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const lines = stripCommentsPreservingLines(source, language).split(/\r?\n/);
  const functions = [];
  const loops = [];
  const conditionals = [];
  const imports = [];
  const errorHandling = [];
  const excludedMethodNames = new Set(["if", "else", "for", "while", "switch", "catch", "try", "with"]);
  let pendingDoWhile = false;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const lineNumber = index + 1;

    // Function declarations and common named function assignments.
    let match = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/)
      ?? line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
      ?? line.match(/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/);
    if (!match) {
      const method = line.match(/^(?:(?:public|private|protected|static|final|synchronized|abstract|inline|virtual|constexpr|async|export|default|override)\s+)*(?:[\w~:<>,\[\].?*&]+\s+)+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\b[^{}]+)?\s*(?:\{|$)/);
      const classMethod = line.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/);
      const name = method?.[1] ?? classMethod?.[1];
      if (name && !excludedMethodNames.has(name)) functions.push({ name, lineNumber });
    } else {
      functions.push({ name: match[1], lineNumber });
    }

    // Imports, package declarations, and C-family include directives.
    if (/^(?:import\b|from\b|package\b|#\s*include\b)/.test(line)) {
      imports.push({ statement: line, lineNumber });
    }

    // Control-flow structures. The for-loop subtype distinguishes range loops.
    if (/\bforEach\s*\(/.test(line)) loops.push({ type: "forEach", lineNumber });
    const forMatch = line.match(/\bfor\s*\(([^)]*)\)/);
    if (forMatch) {
      loops.push({ type: forMatch[1].includes(":") && !forMatch[1].includes(";") ? "enhanced-for" : "for", lineNumber });
    } else if (/^(?:async\s+)?for\s+\w+\s+in\b/.test(line)) {
      loops.push({ type: "for", lineNumber });
    }
    if (/^do\b/.test(line)) {
      loops.push({ type: "do-while", lineNumber });
      pendingDoWhile = true;
    }
    if (/^while\s+.+:\s*$/.test(line) || /\bwhile\s*\(/.test(line)) {
      if (pendingDoWhile && /\)\s*;\s*$/.test(line)) pendingDoWhile = false;
      else loops.push({ type: "while", lineNumber });
    }

    // Branches in C-like, JavaScript, and Python syntax.
    if (/^(?:}\s*)?else\s+if\b|^elif\b/.test(line)) conditionals.push({ type: "else-if", lineNumber });
    else if (/^(?:}\s*)?if\b/.test(line)) conditionals.push({ type: "if", lineNumber });
    if (/^(?:}\s*)?else\b/.test(line) && !/^(?:}\s*)?else\s+if\b/.test(line)) conditionals.push({ type: "else", lineNumber });
    if (/\bswitch\s*\(|^match\s+.+:/.test(line)) conditionals.push({ type: "switch", lineNumber });

    // Exception handling and explicit exception propagation.
    for (const keyword of ["try", "catch", "except", "finally", "throw", "raise"]) {
      if (new RegExp(`(?:^|[}\\s])${keyword}\\b`).test(line)) errorHandling.push({ keyword, lineNumber });
    }
  });

  return {
    functions,
    loops,
    conditionals,
    imports,
    errorHandling,
    counts: {
      functions: functions.length,
      loops: loops.length,
      conditionals: conditionals.length,
      imports: imports.length,
      errorHandling: errorHandling.length
    }
  };
}

function blockRangeFor(lines, lineIndex, language) {
  const line = lines[lineIndex] ?? "";
  const openingBrace = line.indexOf("{");
  if (openingBrace >= 0) {
    let depth = 0;
    for (let index = lineIndex; index < lines.length; index += 1) {
      for (const char of lines[index]) {
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
      }
      if (depth <= 0) return { blockStart: lineIndex + 1, blockEnd: index + 1 };
    }
    return { blockStart: lineIndex + 1, blockEnd: lines.length };
  }

  if (language === "python" && /^(?:\s*)(?:while|for|if|elif|else|try|except|finally|def)\b.*:\s*$/.test(line)) {
    const indent = line.length - line.trimStart().length;
    let endIndex = lineIndex;
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      if (lines[index].trim() && lines[index].length - lines[index].trimStart().length <= indent) break;
      endIndex = index;
    }
    return { blockStart: lineIndex + 1, blockEnd: endIndex + 1 };
  }
  return { blockStart: lineIndex + 1, blockEnd: lineIndex + 1 };
}

/** Selects one high-priority source location and its surrounding code block. */
export function findPrimaryIssue(code) {
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const lines = stripCommentsPreservingLines(source, language).split(/\r?\n/);
  const safeCheck = runSafeCodeChecks(source);

  // Loop termination risks take precedence because they can prevent progress.
  const loopRisk = safeCheck.riskyLines[0];
  if (loopRisk) {
    const range = blockRangeFor(lines, loopRisk.lineNumber - 1, language);
    return {
      lineNumber: loopRisk.lineNumber,
      ...range,
      issueType: "loop-termination-or-bounds",
      severity: "high",
      hint: "Kaunsi condition ya state change loop ko rokegi, aur kya har iteration uske kareeb le jaati hai?"
    };
  }

  // JavaScript syntax can be checked without executing the submission.
  if (language === "javascript") {
    try {
      new vm.Script(source, { filename: "<submission>" });
    } catch (error) {
      const lineNumber = lineFromError(error) ?? 1;
      return {
        lineNumber,
        ...blockRangeFor(lines, lineNumber - 1, language),
        issueType: "syntax-or-statement-check",
        severity: "high",
        hint: "Parser kis expression ya delimiter ka intezar kar raha hai us line ke paas?"
      };
    }
  }

  // Reuse the static checks for zero divisors and likely missing C-style semicolons.
  const staticIssues = [];
  analyzeStatic(source, language, staticIssues);
  const divisionIssue = staticIssues.find(({ issueType }) => issueType === "possible-division-by-zero");
  if (divisionIssue) {
    const lineNumber = divisionIssue.lineNumber;
    return {
      lineNumber,
      ...blockRangeFor(lines, lineNumber - 1, language),
      issueType: "syntax-or-statement-check",
      severity: "high",
      hint: "Is operation ka right-hand value zero ho sakta hai? Kaunsi input ya condition is possibility ko verify karegi?"
    };
  }
  const statementIssue = staticIssues.find(({ issueType }) => issueType === "possible-missing-semicolon");
  if (statementIssue) {
    const lineNumber = statementIssue.lineNumber;
    return {
      lineNumber,
      ...blockRangeFor(lines, lineNumber - 1, language),
      issueType: "syntax-or-statement-check",
      severity: "medium",
      hint: "Kya yeh statement yahin poora hota hai, aur language ko iske end par kya chahiye?"
    };
  }

  const structure = inspectCodeStructure(source);
  const thrown = structure.errorHandling.find(({ keyword }) => keyword === "throw" || keyword === "raise");
  const hasHandler = structure.errorHandling.some(({ keyword }) => keyword === "catch" || keyword === "except");
  if (thrown && !hasHandler) {
    return {
      lineNumber: thrown.lineNumber,
      ...blockRangeFor(lines, thrown.lineNumber - 1, language),
      issueType: "error-handling-missing",
      severity: "medium",
      hint: "Agar yahan error raise hota hai, kaunsa hissa usse handle karega?"
    };
  }

  const firstCodeLine = lines.findIndex((line) => line.trim());
  const lineNumber = firstCodeLine < 0 ? 1 : firstCodeLine + 1;
  return {
    lineNumber,
    ...blockRangeFor(lines, lineNumber - 1, language),
    issueType: "logic-review",
    severity: "low",
    hint: "Is hissa ko ek chhote input ke saath dry-run karke dekho—kya har branch expected result tak pahunchti hai?"
  };
}

/**
 * Scores three core rubric areas using only visible source patterns. “Partial”
 * indicates some supporting structure exists, while “Met” requires a concrete
 * corresponding check or handling construct in the submitted text.
 */
export function evaluateRubric(code, rubricPoints = []) {
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const cleanSource = stripCommentsPreservingLines(source, language);
  const structure = inspectCodeStructure(source);
  const safeCheck = runSafeCodeChecks(source);
  const lines = cleanSource.split(/\r?\n/);

  const loops = structure.loops;
  const riskyLoopLines = new Set(safeCheck.riskyLines.map(({ lineNumber }) => lineNumber));
  const hasLoop = loops.length > 0;
  const hasRiskyLoop = loops.some(({ lineNumber }) => riskyLoopLines.has(lineNumber));
  let loopStatus = "Missing";
  let loopReason = "No loop was found to assess for bounds or termination.";
  if (hasLoop && hasRiskyLoop) {
    loopStatus = "Missing";
    loopReason = `A loop on line ${[...riskyLoopLines][0]} has no clear termination progress or uses an unconditional condition.`;
  } else if (hasLoop && safeCheck.capped) {
    loopStatus = "Partial";
    loopReason = "Loops are present, but the static check reached its line budget before all loop bodies could be reviewed.";
  } else if (hasLoop) {
    loopStatus = "Partial";
    loopReason = "Loop constructs are present and no unconditional or unchanged-control pattern was found; actual bounds still need review.";
  }

  // Recognize explicit input checks, boundary comparisons, and validation APIs.
  const guardPattern = /\b(if|else\s+if|elif|assert|require)\b|\b(?:isEmpty|isBlank|isNaN|isFinite|validate|checkRange)\s*\(/i;
  const boundaryPattern = /(?:<=|>=|===?|!==?|[<>]|\b(?:null|undefined|None|NaN)\b|\.length\s*(?:===?|<=|>=|>|<)|\b(?:min|max|lower|upper|range|empty|valid)\b)/i;
  const guardLines = lines
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line && guardPattern.test(line));
  const hasValidation = guardLines.length > 0;
  const hasBoundaryValidation = guardLines.some(({ line }) => boundaryPattern.test(line));
  let validationStatus = "Missing";
  let validationReason = "No input validation or conditional guard was found.";
  if (hasValidation && hasBoundaryValidation) {
    validationStatus = "Met";
    validationReason = `A guard with a boundary or validity check appears on line ${guardLines.find(({ line }) => boundaryPattern.test(line)).lineNumber}.`;
  } else if (hasValidation) {
    validationStatus = "Partial";
    validationReason = `A conditional or validation construct appears on line ${guardLines[0].lineNumber}, but no clear boundary check was detected.`;
  }

  // Exception constructs count as evidence; a lone throw/raise without a
  // handler is only partial because it propagates rather than handles errors.
  const errorKeywords = new Set(structure.errorHandling.map(({ keyword }) => keyword));
  const hasHandler = errorKeywords.has("catch") || errorKeywords.has("except");
  const hasTry = errorKeywords.has("try");
  const hasThrow = errorKeywords.has("throw") || errorKeywords.has("raise");
  let errorStatus = "Missing";
  let errorReason = "No try/catch/except, throw/raise, or defensive error guard was found.";
  if (hasTry && hasHandler) {
    errorStatus = "Met";
    errorReason = "Both a try block and a catch/except handler were found.";
  } else if (hasTry || hasHandler) {
    errorStatus = "Partial";
    errorReason = hasTry
      ? "A try block was found, but no catch/except handler was detected."
      : "A catch/except block was found, but no matching try block was detected.";
  } else if (hasThrow) {
    errorStatus = "Partial";
    errorReason = "A throw/raise statement was found, but no handler was detected.";
  } else if (hasValidation) {
    errorStatus = "Partial";
    errorReason = `A defensive conditional appears on line ${guardLines[0].lineNumber}, but no exception handling construct was found.`;
  }

  const checks = [
    { id: "loop-termination-safety", criterion: "Loop & Termination Safety", status: loopStatus, reason: loopReason },
    { id: "input-boundary-guard", criterion: "Input & Boundary Guard", status: validationStatus, reason: validationReason },
    { id: "exception-error-handling", criterion: "Exception / Error Handling", status: errorStatus, reason: errorReason }
  ];

  // Custom points may name a known rubric area or provide explicit tokens.
  // Evidence is searched in comment-stripped code and the structural index.
  const customChecks = (Array.isArray(rubricPoints) ? rubricPoints : []).map((point, index) => {
    const item = typeof point === "string" ? { title: point } : (point && typeof point === "object" ? point : {});
    const criterion = String(item.title ?? item.criterion ?? item.id ?? `Custom requirement ${index + 1}`);
    const generatedId = criterion.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `custom-${index + 1}`;
    const id = String(item.id ?? generatedId);
    const keywords = (Array.isArray(item.keywords) ? item.keywords : [])
      .filter((keyword) => typeof keyword === "string" && keyword.trim())
      .map((keyword) => keyword.trim());
    const description = `${criterion} ${keywords.join(" ")}`.toLowerCase();
    const category = /loop|terminat|bound|iteration/.test(description) ? "loop"
      : /input|validat|guard|boundary|edge case/.test(description) ? "validation"
        : /error|exception|try|catch|except|throw/.test(description) ? "error"
          : /function|method|class|struct|interface/.test(description) ? "structure" : "keywords";
    let status = "Missing";
    let reason = "No matching code structure or keyword was found.";

    if (category === "loop") {
      if (loops.length && riskyLoopLines.size === 0 && !safeCheck.capped) {
        status = "Met";
        reason = "Loop constructs were found and no unconditional or unchanged-control loop was detected.";
      } else if (loops.length) {
        status = "Partial";
        reason = riskyLoopLines.size
          ? `A loop is present, but line ${[...riskyLoopLines][0]} has a termination risk.`
          : "Loop constructs were found, but their bounds could not all be verified.";
      } else reason = "No loop construct was found.";
    } else if (category === "validation") {
      status = validationStatus;
      reason = validationReason;
    } else if (category === "error") {
      status = errorStatus;
      reason = errorReason;
    } else if (category === "structure") {
      const classMatch = cleanSource.match(/\b(?:class|struct|interface)\s+([A-Za-z_$][\w$]*)/);
      const functionMatch = structure.functions[0];
      if (functionMatch || classMatch) {
        status = "Met";
        const found = functionMatch ? `function/method '${functionMatch.name}' on line ${functionMatch.lineNumber}` : `type '${classMatch[1]}'`;
        reason = `Found ${found}, matching the requested code structure.`;
      } else reason = "No function, method, class, struct, or interface declaration was found.";
    } else {
      const terms = keywords.length ? keywords : criterion
        .split(/[^\p{L}\p{N}_+#.-]+/u)
        .filter((word) => word.length > 2 && !/^(?:the|and|for|with|that|this|code|should|must|include|implement|have|has|use|using)$/.test(word.toLowerCase()));
      if (!terms.length) {
        reason = "This requirement has no searchable keywords; add keywords to make the check specific.";
      } else {
        const matched = terms.filter((term) => {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = /^[\w$]+$/.test(term) ? `\\b${escaped}\\b` : escaped;
          return new RegExp(pattern, "i").test(cleanSource);
        });
        if (matched.length === terms.length) {
          status = "Met";
          reason = `Found all requested keyword(s): ${matched.join(", ")}.`;
        } else if (matched.length) {
          status = "Partial";
          reason = `Found ${matched.join(", ")}; not found: ${terms.filter((term) => !matched.includes(term)).join(", ")}.`;
        } else {
          reason = `None of the requested keyword(s) were found: ${terms.join(", " )}.`;
        }
      }
    }

    return { id, criterion, status, reason };
  });

  return {
    hasErrorHandling: errorStatus !== "Missing",
    hasValidation: validationStatus !== "Missing",
    hasSafeLoop: hasLoop && !hasRiskyLoop && !safeCheck.capped,
    checks,
    customChecks
  };
}

/**
 * Reviews common edge cases through bounded, comment-aware static inspection.
 * It never runs student code, so uncertain behavior is reported as WARN.
 */
export function simulateEdgeCases(code) {
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const cleanSource = stripCommentsPreservingLines(source, language);
  const lines = cleanSource.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join("\n");
  const structure = inspectCodeStructure(source);
  const loopCheck = runSafeCodeChecks(source);
  const results = [];

  // Empty/missing input is considered handled only when a visible guard exists.
  const emptyInputGuard = /\b(?:null|undefined|None|nil)\b|\b(?:isEmpty|isBlank)\s*\(|\.length\s*(?:===?|<=)\s*0|\bif\s*\(\s*!\s*[A-Za-z_$][\w$]*\s*\)|\bif\s+not\s+[A-Za-z_]\w*/i;
  const inputDereference = /\b[A-Za-z_$][\w$]*\s*(?:\.\s*(?:length|trim|map|filter)|\[\s*0\s*\])/;
  if (emptyInputGuard.test(joined)) {
    results.push({ id: "EC-1", scenario: "Empty, null, or missing input", status: "PASS", detail: "A null/empty check or an empty-collection guard is present in the code." });
  } else if (inputDereference.test(joined)) {
    results.push({ id: "EC-1", scenario: "Empty, null, or missing input", status: "FAIL", detail: "The code dereferences or indexes an input, but no null or empty-input guard was found." });
  } else {
    results.push({ id: "EC-1", scenario: "Empty, null, or missing input", status: "WARN", detail: "No explicit empty, null, or missing-input handling was found." });
  }

  // Look for explicit zero/negative checks and literal zero divisors.
  const zeroNegativeGuard = /(?:<=\s*0|<\s*0|===?\s*0|!==?\s*0|\b(?:zero|negative|positive)\b|\b(?:min|minimum)\b)/i;
  const zeroDivisor = /(?:\/\/|\/|%)\s*(?:0+(?:\.0*)?|\.0+)(?![\w.])/;
  if (zeroDivisor.test(joined)) {
    results.push({ id: "EC-2", scenario: "Zero and negative values", status: "FAIL", detail: "A division or remainder by a literal zero appears in the code." });
  } else if (zeroNegativeGuard.test(joined)) {
    results.push({ id: "EC-2", scenario: "Zero and negative values", status: "PASS", detail: "A zero/negative boundary comparison or sign-related guard is present." });
  } else {
    results.push({ id: "EC-2", scenario: "Zero and negative values", status: "WARN", detail: "No explicit checks for zero or negative values were found." });
  }

  // Array bounds are supported by non-empty and index-vs-length comparisons.
  const emptyCollectionGuard = /\.length\s*>\s*0|\.isEmpty\s*\(\s*\)\s*={2,3}\s*false|\bnot\s+\w+\.isEmpty\s*\(\)/i;
  const upperBoundGuard = /(?:<\s*[A-Za-z_$][\w$]*\.length|<=\s*[A-Za-z_$][\w$]*\.length\s*-\s*1|\b(?:index|idx|i)\b\s*<\s*\w+\.length)/i;
  const offByOneRisk = /\b(?:index|idx|i)\b\s*<=\s*\w+\.length|\w+\s*\[\s*\w+\.length\s*\]/i;
  if (offByOneRisk.test(joined)) {
    results.push({ id: "EC-3", scenario: "Empty collection, single element, and index boundaries", status: "FAIL", detail: "An index appears to reach the collection length itself, which is outside the last valid position." });
  } else if (emptyCollectionGuard.test(joined) && upperBoundGuard.test(joined)) {
    results.push({ id: "EC-3", scenario: "Empty collection, single element, and index boundaries", status: "PASS", detail: "The code checks for a non-empty collection and compares an index against its length." });
  } else if (structure.loops.length || /\[[^\]]+\]/.test(joined)) {
    results.push({ id: "EC-3", scenario: "Empty collection, single element, and index boundaries", status: "WARN", detail: "Collection or loop access is present, but a complete empty/single-element and upper-bound guard was not found." });
  } else {
    results.push({ id: "EC-3", scenario: "Empty collection, single element, and index boundaries", status: "WARN", detail: "No collection boundary checks were found to assess empty or single-element cases." });
  }

  // The loop guard detects clear non-terminating patterns; static text cannot
  // establish runtime cost for arbitrary large inputs, so bounded loops remain WARN.
  if (loopCheck.riskyLines.length) {
    const firstRisk = loopCheck.riskyLines[0];
    results.push({ id: "EC-4", scenario: "Loop termination and extreme input size", status: "FAIL", detail: `A loop on line ${firstRisk.lineNumber} has a termination risk: ${firstRisk.reason}` });
  } else if (structure.loops.length && !loopCheck.capped) {
    results.push({ id: "EC-4", scenario: "Loop termination and extreme input size", status: "WARN", detail: "No clear infinite-loop pattern was detected, but runtime cost on very large inputs cannot be confirmed by static inspection." });
  } else if (loopCheck.capped) {
    results.push({ id: "EC-4", scenario: "Loop termination and extreme input size", status: "WARN", detail: "The bounded loop scan reached its source-line budget before the full program was reviewed." });
  } else {
    results.push({ id: "EC-4", scenario: "Loop termination and extreme input size", status: "PASS", detail: "No loop requiring termination or large-input review was found." });
  }

  return results;
}

/**
 * Finds termination and boundary risks in loop headers and their nearby bodies.
 * This is static inspection only; no submitted code is evaluated.
 */
export function analyzeLoopBounds(code) {
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const lines = stripCommentsPreservingLines(source, language).split(/\r?\n/);
  const findings = [];
  const ignoredLines = new Set();

  const getBody = (startIndex, endIndex = lines.length - 1) => {
    const header = lines[startIndex] ?? "";
    const braceStart = header.indexOf("{");
    if (braceStart >= 0) {
      let depth = 0;
      let bodyEnd = startIndex;
      for (let index = startIndex; index <= endIndex; index += 1) {
        for (const char of lines[index]) {
          if (char === "{") depth += 1;
          else if (char === "}") depth -= 1;
        }
        bodyEnd = index;
        if (depth <= 0) break;
      }
      return { body: lines.slice(startIndex, bodyEnd + 1).join("\n"), endIndex: bodyEnd };
    }
    if (/^\s*(?:while|for)\s+.+:\s*$/.test(header)) {
      const indent = header.length - header.trimStart().length;
      let bodyEnd = startIndex;
      for (let index = startIndex + 1; index <= endIndex; index += 1) {
        if (lines[index].trim() && lines[index].length - lines[index].trimStart().length <= indent) break;
        bodyEnd = index;
      }
      return { body: lines.slice(startIndex + 1, bodyEnd + 1).join("\n"), endIndex: bodyEnd };
    }
    const inline = header.match(/\)\s*([^{}].+?)\s*;?\s*$/);
    if (inline) return { body: inline[1], endIndex: startIndex };
    return { body: lines[startIndex + 1] ?? "", endIndex: Math.min(startIndex + 1, endIndex) };
  };

  const addFinding = (lineNumber, loopType, riskType, severity, message) => {
    findings.push({ lineNumber, loopType, riskType, severity, message });
  };

  const analyzeOne = ({ index, type, header, condition, body, details }) => {
    const lineNumber = index + 1;
    if (details?.unconditional || /^(?:true|1)$/i.test((condition ?? "").trim())) {
      addFinding(lineNumber, type, "unbounded-loop", "high", "Loop condition is unconditional, so this loop has no visible termination bound.");
    } else if (details?.control && !details.updateChangesControl && !controlVariableChanges(body, details.control)) {
      addFinding(lineNumber, type, "missing-progress", "high", `Control variable '${details.control}' is not updated in the loop body or update clause.`);
    }

    // Inclusive comparison against a collection length/size can reach an
    // invalid index; also catch statically contradictory literal bounds.
    const control = details?.control;
    const inclusiveCollectionBound = control && new RegExp(`\\b${control.replace(/[$]/g, "\\$")}\\b\\s*<=\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?(?:length|size)\\b`, "i").test(condition ?? "");
    const forParts = header.match(/\bfor\s*\(([^)]*)\)/)?.[1].split(";");
    let contradictory = false;
    if (forParts?.length === 3) {
      const initial = forParts[0].match(/=\s*(-?\d+)\s*$/);
      const bound = forParts[1].match(/(?:<|<=|>|>=)\s*(-?\d+)\s*$/);
      const operator = forParts[1].match(/(?:<=|>=|<|>)/)?.[0];
      const updateDirection = /\+\+|\+=/.test(forParts[2]) ? 1 : /--|-=/.test(forParts[2]) ? -1 : 0;
      if (initial && bound && operator) {
        const start = Number(initial[1]);
        const limit = Number(bound[1]);
        contradictory = ((operator === "<" && start >= limit) || (operator === "<=" && start > limit)
          || (operator === ">" && start <= limit) || (operator === ">=" && start < limit))
          || (updateDirection > 0 && operator.startsWith(">"))
          || (updateDirection < 0 && operator.startsWith("<"));
      }
    }
    if (inclusiveCollectionBound || contradictory) {
      addFinding(lineNumber, type, "off-by-one-or-bound", "medium",
        inclusiveCollectionBound
          ? "The loop uses an inclusive index bound at a collection length/size, which may step past the last valid element."
          : "The loop's starting value or update direction appears inconsistent with its comparison bound.");
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    if (ignoredLines.has(index)) continue;
    const line = lines[index];
    if (/^\s*do\b/.test(line)) {
      const bodyRange = getBody(index);
      let trailingWhile = bodyRange.endIndex + 1;
      while (trailingWhile < lines.length && !lines[trailingWhile].trim()) trailingWhile += 1;
      const whileLine = lines[trailingWhile] ?? "";
      const condition = whileLine.match(/\bwhile\s*\(([^)]*)\)/)?.[1] ?? "";
      const details = loopDetails(whileLine);
      analyzeOne({ index, type: "do-while", header: whileLine, condition, body: bodyRange.body, details });
      if (/\bwhile\s*\(/.test(whileLine)) ignoredLines.add(trailingWhile);
      continue;
    }

    const forMatch = line.match(/\bfor\s*\(([^)]*)\)/);
    const whileMatch = line.match(/\bwhile\s*\(([^)]*)\)/);
    const pythonWhile = line.match(/^\s*while\s+(.+?)\s*:\s*$/);
    const pythonFor = /^\s*(?:async\s+)?for\s+\w+\s+in\s+.+:\s*$/.test(line);
    if (!forMatch && !whileMatch && !pythonWhile && !pythonFor) continue;

    const type = forMatch || pythonFor ? "for" : "while";
    const condition = forMatch?.[1].split(";")[1] ?? whileMatch?.[1] ?? pythonWhile?.[1] ?? "";
    const details = loopDetails(line);
    const bodyRange = getBody(index);
    analyzeOne({ index, type, header: line, condition, body: bodyRange.body, details });
    if (bodyRange.endIndex > index) index = bodyRange.endIndex;
  }

  findings.sort((a, b) => a.lineNumber - b.lineNumber || (a.severity === "high" ? -1 : 1));
  return { hasRisk: findings.length > 0, findings };
}

/**
 * Finds exception constructs, defensive checks, and common unguarded failure
 * points. This is a static heuristic: it reports visible evidence only.
 */
export function checkErrorHandling(code) {
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const lines = stripCommentsPreservingLines(source, language).split(/\r?\n/);
  const handlers = [];
  const defensiveGuards = [];
  const riskOperations = [];
  const keywords = ["try", "catch", "except", "finally", "throw", "throws", "raise"];
  const keywordPattern = new RegExp(`\\b(${keywords.join("|")})\\b`, "gi");
  const guardPattern = /\b(?:if|elif)\b[^\n;]*(?:\b(?:null|undefined|None|nil|empty)\b|\.length\s*(?:===?|<=)\s*0)|\b[A-Za-z_$][\w$]*\s*(?:===?|!==?|is\s+not?)\s*(?:null|undefined|None|nil)\b|\b(?:isEmpty|isBlank|isNaN|isFinite|validate|checkRange)\s*\(|\.length\s*(?:===?|<=)\s*0|\bif\s*\(\s*!\s*[A-Za-z_$][\w$]*\s*\)|\bif\s+not\s+[A-Za-z_]\w*|\b(?:return|throw|raise)\s+(?:null|None|undefined|false|\w*Error\b)/i;
  const riskPattern = /\b(?:JSON\s*\.\s*parse|parseInt|parseFloat|deserialize|readFile\w*|writeFile\w*|fopen|open|fetch|request|connect|query|execute|send|recv)\s*\(|\b(?:scanf|fread|fwrite)\s*\(|(?:\/\/|\/|%)\s*(?:[A-Za-z_$][\w$]*|0+(?:\.0*)?)(?![\w.])|\b[A-Za-z_$][\w$]*\s*\[\s*[^\]\s][^\]]*\]/i;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const lineNumber = index + 1;
    for (const match of line.matchAll(keywordPattern)) {
      handlers.push({ keyword: match[1].toLowerCase(), lineNumber });
    }
    if (guardPattern.test(line)) defensiveGuards.push({ lineNumber, line });
    if (riskPattern.test(line)) riskOperations.push({ lineNumber, line });
  });

  const keywordSet = new Set(handlers.map(({ keyword }) => keyword));
  const hasExceptionBlocks = keywordSet.has("try") || keywordSet.has("catch") || keywordSet.has("except") || keywordSet.has("finally");

  // Pair try blocks with a following catch/except and retain their source span.
  const protectedRanges = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*try\b/.test(lines[index])) continue;
    let start = index;
    if (!lines[index].includes("{") && language !== "python" && lines[index + 1]?.includes("{")) start = index + 1;
    const range = blockRangeFor(lines, start, language);
    const handlerLine = handlers.find(({ keyword, lineNumber }) =>
      (keyword === "catch" || keyword === "except") && lineNumber >= range.blockEnd && lineNumber <= range.blockEnd + 2
    );
    if (handlerLine) protectedRanges.push({ start, end: range.blockEnd - 1 });
  }

  const missingRisks = riskOperations.filter(({ lineNumber }) => {
    const index = lineNumber - 1;
    const insideHandledTry = protectedRanges.some(({ start, end }) => index >= start && index <= end);
    const nearbyGuard = defensiveGuards.some(({ lineNumber: guardLine }) => guardLine <= lineNumber && lineNumber - guardLine <= 3);
    return !insideHandledTry && !nearbyGuard;
  }).map(({ lineNumber, line }) => ({
    lineNumber,
    reason: `Potentially failing operation lacks a nearby try/catch or defensive guard: ${line.slice(0, 120)}`
  }));

  const hasDefensiveGuards = defensiveGuards.length > 0;
  const hasErrorHandling = hasExceptionBlocks || hasDefensiveGuards;
  const summary = missingRisks.length
    ? `Found ${handlers.length} exception keyword(s) and ${defensiveGuards.length} defensive guard(s); ${missingRisks.length} potentially failing operation(s) still appear unprotected.`
    : hasErrorHandling
      ? `Found ${handlers.length} exception keyword(s) and ${defensiveGuards.length} defensive guard(s); no unprotected common failure points were detected.`
      : riskOperations.length
        ? `Found ${riskOperations.length} potentially failing operation(s), but no exception blocks or defensive guards.`
        : "No exception blocks, defensive guards, or common failure-prone operations were detected.";

  return { hasExceptionBlocks, hasDefensiveGuards, hasErrorHandling, handlers, missingRisks, summary };
}

/**
 * Computes simple size/structure metrics and a transparent heuristic risk tier.
 * Counts are signals for review, not a formal cyclomatic-complexity score.
 */
export function computeCodeMetrics(code) {
  const source = String(code ?? "");
  const language = inferLanguage(source);
  const lineCount = source.length ? source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0) : 0;
  const nonEmptyLineCount = source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const structure = inspectCodeStructure(source);
  const functionCount = structure.functions.length;
  const loopCount = structure.loops.length;
  const branchCount = structure.conditionals.length;
  const cleanLines = stripCommentsPreservingLines(source, language).split(/\r?\n/);

  // Ignore braces inside quoted strings so they do not inflate block depth.
  let inQuote = null;
  let escaped = false;
  let braceDepth = 0;
  let maxBraceDepth = 0;
  for (const line of cleanLines) {
    for (const char of line) {
      if (inQuote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === inQuote) inQuote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") { inQuote = char; continue; }
      if (char === "{") {
        braceDepth += 1;
        maxBraceDepth = Math.max(maxBraceDepth, braceDepth);
      } else if (char === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
      }
    }
  }

  // For Python-style blocks, count active indentation suites introduced by ':'
  // rather than treating every extra indentation space as a nesting level.
  let maxIndentDepth = 0;
  if (language === "python") {
    const stack = [];
    const nextIndentByLine = new Array(cleanLines.length);
    let nextIndent = null;
    for (let index = cleanLines.length - 1; index >= 0; index -= 1) {
      nextIndentByLine[index] = nextIndent;
      if (cleanLines[index].trim()) {
        nextIndent = cleanLines[index].match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
      }
    }
    for (let index = 0; index < cleanLines.length; index += 1) {
      const line = cleanLines[index];
      if (!line.trim()) continue;
      const indentText = line.match(/^\s*/)?.[0] ?? "";
      const indent = indentText.replace(/\t/g, "    ").length;
      while (stack.length && indent <= stack[stack.length - 1]) stack.pop();
      maxIndentDepth = Math.max(maxIndentDepth, stack.length);
      const isBlockHeader = /^\s*(?:(?:async\s+)?def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b.*:\s*(?:#.*)?$/.test(line);
      if (isBlockHeader) {
        const followingIndent = nextIndentByLine[index + 1] ?? indent;
        if (followingIndent > indent) stack.push(indent);
      }
    }
  }
  const maxNestingDepth = Math.max(maxBraceDepth, maxIndentDepth);

  // A small additive heuristic makes the contributors visible and predictable.
  let score = 0;
  const notes = [];
  if (maxNestingDepth >= 4) {
    score += 3;
    notes.push(`Nesting reaches depth ${maxNestingDepth}, which can make control flow harder to follow.`);
  } else if (maxNestingDepth >= 2) {
    score += 1;
    notes.push(`Nesting reaches depth ${maxNestingDepth}; review whether the blocks remain easy to trace.`);
  }
  if (loopCount >= 3) {
    score += 2;
    notes.push(`${loopCount} loops are present, increasing the amount of repeated control flow to review.`);
  } else if (loopCount > 0) {
    score += 1;
    notes.push(`${loopCount} loop${loopCount === 1 ? "" : "s"} ${loopCount === 1 ? "is" : "are"} present.`);
  }
  if (branchCount >= 5) {
    score += 2;
    notes.push(`${branchCount} conditional branches create several paths to reason through.`);
  } else if (branchCount >= 2) {
    score += 1;
    notes.push(`${branchCount} conditional branches are present.`);
  }
  if (nonEmptyLineCount >= 100) {
    score += 2;
    notes.push(`${nonEmptyLineCount} non-empty lines make the submission sizable to review.`);
  } else if (nonEmptyLineCount >= 40) {
    score += 1;
    notes.push(`${nonEmptyLineCount} non-empty lines add some review overhead.`);
  }

  let complexityRisk = score >= 6 ? "High" : score >= 2 ? "Medium" : "Low";
  if (!notes.length) notes.push("No unusually deep nesting, many branches/loops, or large code size was detected by these basic signals.");

  return {
    lineCount,
    nonEmptyLineCount,
    functionCount,
    loopCount,
    branchCount,
    maxNestingDepth,
    complexityRisk,
    notes
  };
}

/** Run all analyzer features and retain the earlier hint endpoint fields. */
export function analyzeSubmission({ code = "", rubricPoints = [], options = {}, notebookNotes = "" } = {}) {
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
  return {
    safeExecution: runSafeCodeChecks(source, options),
    structure: inspectCodeStructure(source),
    loopAnalysis: analyzeLoopBounds(source),
    errorHandling: checkErrorHandling(source),
    primaryIssue: findPrimaryIssue(source),
    rubric: evaluateRubric(source, rubricPoints),
    edgeCases: simulateEdgeCases(source),
    metrics: computeCodeMetrics(source),
    // Compatibility fields still consumed by the existing /api/hint route.
    issues: prioritizedIssues,
    mismatchNote: findMismatchNote(notebookNotes, source)
  };
}
