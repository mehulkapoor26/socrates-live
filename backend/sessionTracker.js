const sessions = new Map();

function createSession(sessionId) {
  return {
    sessionId,
    attempts: 0,
    independentAttempts: 0,
    hintsGiven: 0,
    cheatingAttemptsBlocked: 0,
    flaggedLineNumbers: [],
    issueTypes: [],
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCode: null,
    repeatedCodeHints: 0
  };
}

function getRecord(sessionId = "demo-session") {
  const id = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim().slice(0, 128) : "demo-session";
  if (!sessions.has(id)) sessions.set(id, createSession(id));
  return sessions.get(id);
}

export function recordHint({ sessionId, blockedDirectAnswer = false, lineNumber, issueType, hintLevel, code = "" }) {
  const record = getRecord(sessionId);
  const timestamp = new Date().toISOString();
  record.attempts += 1;
  record.hintsGiven += 1;
  if (blockedDirectAnswer) record.cheatingAttemptsBlocked += 1;
  else if (code.trim() && code !== record.lastCode) record.independentAttempts += 1;
  else if (code === record.lastCode) record.repeatedCodeHints += 1;
  record.lastCode = code;
  if (Number.isInteger(lineNumber) && lineNumber > 0 && !record.flaggedLineNumbers.includes(lineNumber)) {
    record.flaggedLineNumbers.push(lineNumber);
  }
  if (issueType && !record.issueTypes.includes(issueType)) record.issueTypes.push(issueType);
  record.updatedAt = timestamp;
  record.history.push({ timestamp, type: blockedDirectAnswer ? "direct-answer-blocked" : "hint-requested", lineNumber, issueType, hintLevel });
  return getSessionSummary(record.sessionId);
}

export function getSessionSummary(sessionId = "demo-session") {
  const record = getRecord(sessionId);
  const score = Math.max(0, Math.min(100,
    60 + Math.min(record.independentAttempts, 5) * 8 - Math.min(record.cheatingAttemptsBlocked, 5) * 8 - Math.min(record.repeatedCodeHints, 5) * 3
  ));
  let verdict;
  if (!record.attempts) verdict = "Ready to begin — try a problem and work through it step by step.";
  else if (score >= 80) verdict = "Strong independent effort — keep testing your own reasoning.";
  else if (score >= 55) verdict = "Steady progress — use each hint to make and test your own change.";
  else verdict = "Build more independent attempts — try a small change before asking for another hint.";
  return { sessionId: record.sessionId, attempts: record.attempts, independentAttempts: record.independentAttempts, hintsGiven: record.hintsGiven,
    cheatingAttemptsBlocked: record.cheatingAttemptsBlocked, flaggedLineNumbers: [...record.flaggedLineNumbers],
    issueTypes: [...record.issueTypes], history: [...record.history], createdAt: record.createdAt,
    updatedAt: record.updatedAt, independentThinkingScore: score, verdict };
}

export function listActiveSessions() {
  return [...sessions.keys()].map((id) => getSessionSummary(id));
}

export function resetSession(sessionId = "demo-session") {
  const id = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim().slice(0, 128) : "demo-session";
  sessions.set(id, createSession(id));
  return getSessionSummary(id);
}
