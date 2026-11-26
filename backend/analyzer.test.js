import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSubmission } from "./analyzer.js";

test("valid JavaScript returns the stable result shape and a clean hinted issue", () => {
  const result = analyzeSubmission({ code: "const result = 2 + 2;" });

  assert.deepEqual(Object.keys(result).sort(), ["issues", "mismatchNote"]);
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0);
  assert.equal(result.mismatchNote, null);
  assert.equal(result.issues[0].language, "javascript");
  assert.equal(result.issues[0].status, "passed-basic-run");
  assert.ok(result.issues[0].hint.trim().length > 0);
});

test("JavaScript syntax errors report their 1-based source line", () => {
  const result = analyzeSubmission({ code: "const first = 1;\nconst second = ;" });
  const syntaxIssue = result.issues.find(({ issueType }) => issueType === "syntax-error");

  assert.ok(syntaxIssue, "expected a syntax-error issue");
  assert.equal(syntaxIssue.lineNumber, 2);
  assert.equal(syntaxIssue.status, "failed");
  assert.ok(syntaxIssue.evidence.length > 0);
});

test("JavaScript infinite loops are stopped by the VM timeout", () => {
  const startedAt = performance.now();
  const result = analyzeSubmission({ code: "// heading\nwhile (true) {}" });
  const elapsedMs = performance.now() - startedAt;
  const timeoutIssue = result.issues.find(({ issueType }) => issueType === "execution-timeout");

  assert.ok(timeoutIssue, "expected the VM timeout to be reported");
  assert.equal(timeoutIssue.lineNumber, 2);
  assert.equal(timeoutIssue.status, "failed");
  // Allows CI scheduling overhead while guarding against an unbounded runner.
  assert.ok(elapsedMs < 1500, `analysis took ${elapsedMs.toFixed(1)}ms`);
});

const staticSamples = [
  {
    language: "java",
    code: "public class Sample {\n  void run() {\n    while (true) { }\n    int value = 8 / 0;\n  }\n}",
    loopLine: 3,
    zeroLine: 4
  },
  {
    language: "c",
    code: "#include <stdio.h>\nint main() {\n  while (1) { }\n  int value = 8 % 0;\n}",
    loopLine: 3,
    zeroLine: 4
  },
  {
    language: "cpp",
    code: "#include <iostream>\nint main() {\n  for (;;) { }\n  int value = 8 / 0;\n}",
    loopLine: 3,
    zeroLine: 4
  },
  {
    language: "python",
    code: "# loop\nwhile True:\n    pass\nvalue = 8 // 0",
    loopLine: 2,
    zeroLine: 4
  }
];

for (const sample of staticSamples) {
  test(`${sample.language} static checks report unbounded loop and zero divisor lines`, () => {
    const result = analyzeSubmission({ code: sample.code });
    const loopIssue = result.issues.find(({ issueType }) => issueType === "possible-infinite-loop");
    const zeroIssue = result.issues.find(({ issueType }) => issueType === "possible-division-by-zero");

    assert.ok(loopIssue, "expected an unbounded-loop issue");
    assert.equal(loopIssue.language, sample.language);
    assert.equal(loopIssue.lineNumber, sample.loopLine);
    assert.equal(loopIssue.status, "needs-review");
    assert.ok(zeroIssue, "expected a division/modulo-by-zero issue");
    assert.equal(zeroIssue.language, sample.language);
    assert.equal(zeroIssue.lineNumber, sample.zeroLine);
    assert.equal(zeroIssue.status, "needs-review");
  });
}

test("conflicting notebook threshold is reported without providing solution code", () => {
  const result = analyzeSubmission({
    code: "const threshold = 12;",
    notebookNotes: "The expected threshold is 10."
  });

  assert.equal(typeof result.mismatchNote, "string");
  assert.match(result.mismatchNote, /10/);
  assert.match(result.mismatchNote, /12/);
  assert.match(result.mismatchNote, /verify against your notes/i);
  assert.doesNotMatch(result.mismatchNote, /threshold\s*=\s*\d+|```/i);
});
