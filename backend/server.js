import express from "express";
import cors from "cors";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5050;

// Gemini Enterprise (Google Cloud) config via env vars
const GE_ENDPOINT = process.env.GEMINI_ENTERPRISE_ENDPOINT || "";
const GE_TOKEN = process.env.GEMINI_ENTERPRISE_TOKEN || "";
const GE_API_KEY = process.env.GEMINI_API_KEY || "";

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "../frontend")));

// In-memory state for collaborative rooms, integrity logs & cohort tracking
const groups = new Map();
const contests = new Map();
const auditLogs = [];
const cohortStats = {
  submissions: 0,
  bluffsDetected: 0,
  injectionsBlocked: 0,
  weaknessCounts: {
    "loop-termination-or-bounds": 0,
    "error-handling-missing": 0,
    "input-validation-missing": 0,
    "syntax-or-statement-check": 0,
    "logic-review": 0
  }
};

function recordAudit(eventType, actorId, detail, extra = {}) {
  auditLogs.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    timestamp: new Date().toISOString(),
    eventType,
    actorId: actorId || "anonymous",
    detail,
    ...extra
  });
  if (auditLogs.length > 200) auditLogs.pop();
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

function makeCode(prefix = "GRP") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}-${code}`;
}

function buildJoinUrl(kind, code) {
  const host = process.env.PUBLIC_HOST || getLanIp();
  return `http://${host}:${PORT}/?${kind}=${encodeURIComponent(code)}`;
}

function isAskingForDirectSolution(message = "") {
  const text = String(message).toLowerCase();
  const blockedPhrases = [
    "give me full code",
    "complete code",
    "write the whole code",
    "write function",
    "write code",
    "direct answer",
    "just give me the answer",
    "solve it for me",
    "solution bata",
    "answer dedo",
    "code likh de",
    "poora code de",
    "seedha answer",
    "ans bata"
  ];
  return blockedPhrases.some((phrase) => text.includes(phrase));
}

function detectPromptInjection(text = "") {
  const lower = String(text).toLowerCase();
  const patterns = [
    "ignore previous instructions",
    "ignore all instructions",
    "ignore rules",
    "give full marks",
    "give 100% marks",
    "bypass rubric",
    "system prompt",
    "jailbreak",
    "act as root",
    "override grading"
  ];
  return patterns.some((p) => lower.includes(p));
}

function getLevelGuidance(level = 1) {
  if (level <= 1) {
    return "Level 1 (Gentle Nudge): Sirf kis line ya area ko dekhna hai, woh point out karo.";
  }
  if (level === 2) {
    return "Level 2 (Logic/Edge Check): Condition, loop bound, ya edge case par sochne ko kaho.";
  }
  return "Level 3 (Sharp Question): Ek seedha sawaal poochho jo student ko khud next step par le jaye, par answer mat do.";
}

function findStarterIssue(code = "") {
  const lines = String(code).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();

    if ((line.startsWith("while") && line.includes("true")) || line.includes("while (true)")) {
      return {
        lineNumber: lineNum,
        issueType: "loop-termination-or-bounds",
        hint: `Line ${lineNum} dekho: loop termination condition kab false hogi ya boundary kaise rukegi, is par dhyan do.`
      };
    }

    if (
      line &&
      !line.endsWith("{") &&
      !line.endsWith("}") &&
      !line.endsWith(";") &&
      !line.startsWith("//") &&
      !line.startsWith("#") &&
      !line.startsWith("for") &&
      !line.startsWith("if") &&
      !line.startsWith("else") &&
      !line.startsWith("while") &&
      !line.startsWith("def ") &&
      !line.startsWith("import ") &&
      !line.startsWith("from ") &&
      !line.startsWith("package ")
    ) {
      return {
        lineNumber: lineNum,
        issueType: "syntax-or-statement-check",
        hint: `Line ${lineNum} check karo: kya is statement ke end mein kuch missing hai ya syntax theek hai?`
      };
    }
  }

  return {
    lineNumber: lines.length || 1,
    issueType: "logic-review",
    hint: "Apne logic ka ek chhota dry-run karo: boundary/empty/zero inputs par kya hoga?"
  };
}

function evaluateRubricAndCode(code = "", rubricPoints = []) {
  const lower = String(code).toLowerCase();
  const hasErrorHandling =
    lower.includes("try") || lower.includes("catch") || lower.includes("except") || lower.includes("throw");
  const hasValidation =
    lower.includes("if (") ||
    lower.includes("if(") ||
    lower.includes("len(") ||
    lower.includes("length") ||
    lower.includes("null");
  const hasSafeLoop = !(lower.includes("while (true)") || lower.includes("while(true)"));

  const defaultChecks = [
    {
      id: "R1",
      criterion: "Termination & Loop Safety",
      status: hasSafeLoop ? "Met" : "Missing",
      note: hasSafeLoop ? "No obvious unbounded while(true) loop." : "Unbounded loop detected; verify exit condition."
    },
    {
      id: "R2",
      criterion: "Input / Boundary Guard",
      status: hasValidation ? "Partial" : "Missing",
      note: hasValidation ? "Conditional checks found; verify edge/empty inputs." : "No clear input/boundary guard detected."
    },
    {
      id: "R3",
      criterion: "Exception / Error Handling",
      status: hasErrorHandling ? "Met" : "Missing",
      note: hasErrorHandling ? "Error-handling construct present." : "Missing try/catch or error guard."
    }
  ];

  const customChecks = Array.isArray(rubricPoints)
    ? rubricPoints.filter(Boolean).map((item, idx) => ({
        id: `RC-${idx + 1}`,
        criterion: String(item),
        status: "Partial",
        note: "Needs code & test verification against rubric rule."
      }))
    : [];

  return {
    hasErrorHandling,
    hasValidation,
    hasSafeLoop,
    checks: [...defaultChecks, ...customChecks]
  };
}

async function generateGeminiEnterpriseHint({ code, question, hintLevel, fallback }) {
  if (!GE_ENDPOINT) return null;

  const prompt = `
You are VeriCode Studio, a strict Socratic coding mentor on Gemini Enterprise.
Rules:
1. NEVER write full solution code or give the final answer directly.
2. Give ONE short hint/question (max 2 short sentences) in simple Hinglish or match student's language.
3. Focus around line ${fallback.lineNumber} (${fallback.issueType}).
4. ${getLevelGuidance(hintLevel)}

Student doubt: ${question || "Help me find why this has an issue."}
Code:
${code}
`.trim();

  const headers = { "Content-Type": "application/json" };
  if (GE_TOKEN) {
    headers.Authorization = `Bearer ${GE_TOKEN}`;
  } else if (GE_API_KEY) {
    headers["x-goog-api-key"] = GE_API_KEY;
  }

  const resp = await fetch(GE_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    })
  });

  if (!resp.ok) return null;
  const data = await resp.json();

  return (
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    data?.answer?.trim() ||
    data?.reply?.trim() ||
    null
  );
}

app.post("/api/hint", async (req, res) => {
  const { code = "", question = "", hintLevel = 1, studentId = "" } = req.body || {};

  if (!code.trim() && !question.trim()) {
    return res.status(400).json({ error: "Kuch code ya doubt toh daal bhai!" });
  }

  const injectionDetected = detectPromptInjection(`${question}\n${code}`);
  if (injectionDetected) {
    cohortStats.injectionsBlocked += 1;
    recordAudit("PROMPT_INJECTION_BLOCKED", studentId, "Attempted instruction override in code/prompt");
  }

  const clampedLevel = Math.min(Math.max(Number(hintLevel) || 1, 1), 3);
  const found = findStarterIssue(code);
  const blockedDirectAnswer = isAskingForDirectSolution(question);

  cohortStats.submissions += 1;
  if (Object.prototype.hasOwnProperty.call(cohortStats.weaknessCounts, found.issueType)) {
    cohortStats.weaknessCounts[found.issueType] += 1;
  } else {
    cohortStats.weaknessCounts["logic-review"] += 1;
  }

  let aiHint = null;
  try {
    aiHint = await generateGeminiEnterpriseHint({
      code,
      question,
      hintLevel: clampedLevel,
      fallback: found
    });
  } catch (_err) {
    aiHint = null;
  }

  const baseText = aiHint || found.hint;
  const hint = injectionDetected
    ? `Guardrail alert: Rubric/grading override ignore kiya gaya. ${baseText}`
    : blockedDirectAnswer
      ? `Seedha solution nahi milega — ${baseText}`
      : baseText;

  return res.json({
    blockedDirectAnswer,
    injectionDetected,
    lineNumber: found.lineNumber,
    issueType: found.issueType,
    hintLevel: clampedLevel,
    provider: aiHint ? "gemini-enterprise" : "local-fallback",
    hint,
    nextPrompt: "Pehle khud ek chhota badlav karke try karo, phir batao kya hua."
  });
});

app.post("/api/audit", (req, res) => {
  const { code = "", studentId = "", rubricPoints = [] } = req.body || {};
  if (!code.trim()) {
    return res.status(400).json({ error: "Audit ke liye code chahiye." });
  }

  const injectionDetected = detectPromptInjection(code);
  if (injectionDetected) {
    cohortStats.injectionsBlocked += 1;
    recordAudit("PROMPT_INJECTION_BLOCKED", studentId, "Prompt injection found during code audit");
  }

  const issue = findStarterIssue(code);
  const rubric = evaluateRubricAndCode(code, rubricPoints);

  if (!rubric.hasErrorHandling) {
    cohortStats.weaknessCounts["error-handling-missing"] += 1;
  }
  if (!rubric.hasValidation) {
    cohortStats.weaknessCounts["input-validation-missing"] += 1;
  }

  recordAudit("CODE_AUDIT_COMPLETED", studentId, `Primary focus line ${issue.lineNumber} (${issue.issueType})`, {
    injectionDetected
  });

  return res.json({
    primaryIssue: issue,
    injectionDetected,
    rubric
  });
});

app.post("/api/viva/verify", (req, res) => {
  const { code = "", claim = "", studentId = "" } = req.body || {};
  if (!claim.trim()) {
    return res.status(400).json({ error: "Viva claim ya answer text chahiye." });
  }

  if (detectPromptInjection(claim)) {
    cohortStats.injectionsBlocked += 1;
    recordAudit("PROMPT_INJECTION_BLOCKED", studentId, "Injection pattern in viva response");
  }

  const lowerClaim = claim.toLowerCase();
  const lowerCode = String(code).toLowerCase();
  const rubric = evaluateRubricAndCode(code);

  const checks = [];
  if (
    lowerClaim.includes("try") ||
    lowerClaim.includes("catch") ||
    lowerClaim.includes("exception") ||
    lowerClaim.includes("error")
  ) {
    checks.push({ topic: "Error Handling", claimed: true, verifiedInCode: rubric.hasErrorHandling });
  }
  if (
    lowerClaim.includes("edge") ||
    lowerClaim.includes("validation") ||
    lowerClaim.includes("bound") ||
    lowerClaim.includes("null")
  ) {
    checks.push({ topic: "Input / Edge Validation", claimed: true, verifiedInCode: rubric.hasValidation });
  }
  if (
    lowerClaim.includes("loop") ||
    lowerClaim.includes("terminat") ||
    lowerClaim.includes("complexity") ||
    lowerClaim.includes("redis") ||
    lowerClaim.includes("cache")
  ) {
    const tokenMatch =
      (lowerClaim.includes("redis") && lowerCode.includes("redis")) ||
      (lowerClaim.includes("cache") && lowerCode.includes("cache")) ||
      (!lowerClaim.includes("redis") && !lowerClaim.includes("cache") && rubric.hasSafeLoop);
    checks.push({ topic: "Architecture / Loop Claim", claimed: true, verifiedInCode: tokenMatch });
  }

  if (checks.length === 0) {
    checks.push({ topic: "General Implementation Claim", claimed: true, verifiedInCode: lowerCode.trim().length > 15 });
  }

  const bluffDetected = checks.some((c) => c.claimed && !c.verifiedInCode);
  if (bluffDetected) {
    cohortStats.bluffsDetected += 1;
    recordAudit("VIVA_BLUFF_DETECTED", studentId, `Claimed feature missing in code: ${claim.trim()}`);
  } else {
    recordAudit("VIVA_CLAIM_VERIFIED", studentId, `Viva response aligned with code: ${claim.trim()}`);
  }

  return res.json({
    verdict: bluffDetected ? "BLUFF_ALERT" : "VERIFIED",
    bluffDetected,
    checks,
    followUpQuestion: bluffDetected
      ? "Aapne jo feature bola, woh code mein nahi dikha—kaunsi file/line par woh logic hai ya abhi add karna baaki hai?"
      : "Agar input empty ya extreme boundary par aaye, toh aapka current flow kaise behave karega?"
  });
});

app.get("/api/cohort", (_req, res) => {
  return res.json({
    stats: cohortStats,
    recentLogs: auditLogs.slice(0, 25),
    activeGroups: groups.size,
    activeContests: contests.size
  });
});

// --- Study Groups & Peer Suggestions ---
app.post("/api/groups/create", (req, res) => {
  const { studentId = "", groupName = "", sharedCode = "" } = req.body || {};
  if (!studentId.trim() || !groupName.trim()) {
    return res.status(400).json({ error: "Student ID aur Group Name dono chahiye." });
  }

  const code = makeCode("GRP");
  const group = {
    code,
    name: groupName.trim(),
    createdBy: studentId.trim(),
    members: [studentId.trim()],
    sharedCode,
    messages: [
      {
        id: Date.now(),
        studentId: "System",
        type: "info",
        blocked: false,
        text: `${groupName.trim()} group bana by ${studentId.trim()}. Code: ${code}`
      }
    ]
  };
  groups.set(code, group);

  return res.status(201).json({ group, joinUrl: buildJoinUrl("group", code) });
});

app.post("/api/groups/join", (req, res) => {
  const { studentId = "", code = "" } = req.body || {};
  const cleanCode = code.trim().toUpperCase();
  const group = groups.get(cleanCode);

  if (!studentId.trim() || !cleanCode) {
    return res.status(400).json({ error: "Student ID aur Group Code daalo." });
  }
  if (!group) {
    return res.status(404).json({ error: "Group code nahi mila." });
  }

  const cleanId = studentId.trim();
  if (!group.members.includes(cleanId)) {
    group.members.push(cleanId);
    group.messages.push({
      id: Date.now() + Math.floor(Math.random() * 100),
      studentId: "System",
      type: "info",
      blocked: false,
      text: `${cleanId} ne group join kiya.`
    });
  }

  return res.json({ group, joinUrl: buildJoinUrl("group", cleanCode) });
});

app.get("/api/groups/:code", (req, res) => {
  const cleanCode = (req.params.code || "").trim().toUpperCase();
  const group = groups.get(cleanCode);
  if (!group) {
    return res.status(404).json({ error: "Group nahi mila." });
  }
  return res.json({ group, joinUrl: buildJoinUrl("group", cleanCode) });
});

app.post("/api/groups/:code/suggest", (req, res) => {
  const cleanCode = (req.params.code || "").trim().toUpperCase();
  const group = groups.get(cleanCode);
  const { studentId = "", text = "", kind = "suggestion", sharedCode } = req.body || {};

  if (!group) {
    return res.status(404).json({ error: "Group nahi mila." });
  }
  if (!studentId.trim() || !text.trim()) {
    return res.status(400).json({ error: "Student ID aur suggestion/message likho." });
  }

  const cleanId = studentId.trim();
  if (!group.members.includes(cleanId)) {
    group.members.push(cleanId);
  }
  if (typeof sharedCode === "string") {
    group.sharedCode = sharedCode;
  }

  const blocked = isAskingForDirectSolution(text) || detectPromptInjection(text);
  const finalText = blocked
    ? "Guardrail active: Seedha answer/override allow nahi — hint ya logic approach share karo."
    : text.trim();

  const entry = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    studentId: cleanId,
    type: kind === "suggestion" ? "suggestion" : "chat",
    blocked,
    text: finalText
  };
  group.messages.push(entry);

  return res.status(201).json({ entry, group });
});

// --- Code & QR Contests ---
app.post("/api/contests/create", (req, res) => {
  const { hostId = "", title = "", prompt = "", starterCode = "" } = req.body || {};
  if (!hostId.trim() || !title.trim()) {
    return res.status(400).json({ error: "Host ID aur Contest Title chahiye." });
  }

  const code = makeCode("QRC");
  const contest = {
    code,
    title: title.trim(),
    hostId: hostId.trim(),
    prompt: prompt.trim() || "Bug dhoondo aur Socratic hints ke saath logic fix karo.",
    starterCode: starterCode || "int count = 0;\nwhile (true) {\n  count++;\n}",
    participants: [
      {
        studentId: hostId.trim(),
        joinedAt: new Date().toISOString(),
        attempts: 0,
        lastNote: "Host joined"
      }
    ]
  };
  contests.set(code, contest);

  return res.status(201).json({ contest, joinUrl: buildJoinUrl("contest", code) });
});

app.post("/api/contests/join", (req, res) => {
  const { studentId = "", code = "" } = req.body || {};
  const cleanCode = code.trim().toUpperCase();
  const contest = contests.get(cleanCode);

  if (!studentId.trim() || !cleanCode) {
    return res.status(400).json({ error: "Student ID aur Contest Code daalo." });
  }
  if (!contest) {
    return res.status(404).json({ error: "Contest code nahi mila." });
  }

  const cleanId = studentId.trim();
  let member = contest.participants.find((p) => p.studentId === cleanId);
  if (!member) {
    member = {
      studentId: cleanId,
      joinedAt: new Date().toISOString(),
      attempts: 0,
      lastNote: "Joined contest"
    };
    contest.participants.push(member);
  }

  return res.json({ contest, joinUrl: buildJoinUrl("contest", cleanCode) });
});

app.post("/api/contests/:code/attempt", (req, res) => {
  const cleanCode = (req.params.code || "").trim().toUpperCase();
  const contest = contests.get(cleanCode);
  const { studentId = "", note = "" } = req.body || {};

  if (!contest) {
    return res.status(404).json({ error: "Contest nahi mila." });
  }
  if (!studentId.trim()) {
    return res.status(400).json({ error: "Student ID chahiye." });
  }

  const cleanId = studentId.trim();
  let member = contest.participants.find((p) => p.studentId === cleanId);
  if (!member) {
    member = {
      studentId: cleanId,
      joinedAt: new Date().toISOString(),
      attempts: 0,
      lastNote: ""
    };
    contest.participants.push(member);
  }

  member.attempts += 1;
  member.lastNote = isAskingForDirectSolution(note)
    ? "Guardrail blocked direct answer attempt"
    : note.trim() || `Attempt #${member.attempts}`;

  return res.json({ contest });
});

app.get("/api/contests/:code", (req, res) => {
  const cleanCode = (req.params.code || "").trim().toUpperCase();
  const contest = contests.get(cleanCode);
  if (!contest) {
    return res.status(404).json({ error: "Contest nahi mila." });
  }
  return res.json({ contest, joinUrl: buildJoinUrl("contest", cleanCode) });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "VeriCode Studio",
    geminiEnterpriseConfigured: Boolean(GE_ENDPOINT),
    activeGroups: groups.size,
    activeContests: contests.size
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VeriCode Studio backend running on http://localhost:${PORT} (LAN: http://${getLanIp()}:${PORT})`);
});