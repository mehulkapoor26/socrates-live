import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5050;

// Gemini Enterprise (Google Cloud) config via env vars
const GE_ENDPOINT = process.env.GEMINI_ENTERPRISE_ENDPOINT || "";
const GE_TOKEN = process.env.GEMINI_ENTERPRISE_TOKEN || "";
const GE_API_KEY = process.env.GEMINI_API_KEY || "";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function isAskingForDirectSolution(message = "") {
  const text = message.toLowerCase();
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
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();

    if (line.startsWith("while") && line.includes("true")) {
      return {
        lineNumber: lineNum,
        issueType: "possible-infinite-loop",
        hint: `Line ${lineNum} dekho: condition kab false hogi ya loop break kaise hoga, is par dhyan do.`
      };
    }

    if (
      line &&
      !line.endsWith("{") &&
      !line.endsWith("}") &&
      !line.endsWith(";") &&
      !line.startsWith("//") &&
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
    hint: "Apne logic ka ek chhota dry-run karo: sabse chhote input (jaise 0, 1, ya empty) par kya hoga?"
  };
}

// Routes through Gemini Enterprise (Google Cloud) endpoint when configured
async function generateGeminiEnterpriseHint({ code, question, hintLevel, fallback }) {
  if (!GE_ENDPOINT) return null;

  const prompt = `
You are SocratesLive, a strict Socratic coding mentor on Gemini Enterprise.
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

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    data?.answer?.trim() ||
    data?.reply?.trim() ||
    null;

  return text;
}

app.post("/api/hint", async (req, res) => {
  const { code = "", question = "", hintLevel = 1 } = req.body || {};

  if (!code.trim() && !question.trim()) {
    return res.status(400).json({
      error: "Kuch code ya doubt toh daal bhai!"
    });
  }

  const clampedLevel = Math.min(Math.max(Number(hintLevel) || 1, 1), 3);
  const found = findStarterIssue(code);
  const blockedDirectAnswer = isAskingForDirectSolution(question);

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
  const hint = blockedDirectAnswer
    ? `Seedha solution nahi milega — ${baseText}`
    : baseText;

  return res.json({
    blockedDirectAnswer,
    lineNumber: found.lineNumber,
    issueType: found.issueType,
    hintLevel: clampedLevel,
    provider: aiHint ? "gemini-enterprise" : "local-fallback",
    hint,
    nextPrompt: "Pehle khud ek chhota badlav karke try karo, phir batao kya hua."
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "SocratesLive",
    geminiEnterpriseConfigured: Boolean(GE_ENDPOINT)
  });
});

app.listen(PORT, () => {
  console.log(`SocratesLive backend running on http://localhost:${PORT}`);
});