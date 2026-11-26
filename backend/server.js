import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5050;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function isAskingForDirectSolution(message = "") {
  const text = message.toLowerCase();
  const blockedPhrases = [
    "give me full code",
    "complete code",
    "write the whole code",
    "direct answer",
    "just give me the answer",
    "solve it for me",
    "poora code de",
    "seedha answer",
    "ans bata"
  ];
  return blockedPhrases.some((phrase) => text.includes(phrase));
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

async function generateGeminiHint({ code, question, hintLevel, fallback }) {
  if (!GEMINI_API_KEY) return null;

  const prompt = `
You are SocratesLive, a strict Socratic coding mentor.
Rules:
1. NEVER write full solution code or give the final answer directly.
2. Give ONE short hint/question (max 2 short sentences) in simple Hinglish.
3. Focus around line ${fallback.lineNumber} (${fallback.issueType}).
4. Hint level is ${hintLevel} (1 = gentle nudge, 2 = concept/edge-case check, 3 = sharper targeted question).

Student doubt: ${question || "Help me find why this has an issue."}
Code:
${code}
`.trim();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return text || null;
}

app.post("/api/hint", async (req, res) => {
  const { code = "", question = "", hintLevel = 1 } = req.body || {};

  if (!code.trim() && !question.trim()) {
    return res.status(400).json({
      error: "Kuch code ya doubt toh daal bhai!"
    });
  }

  const found = findStarterIssue(code);
  const blockedDirectAnswer = isAskingForDirectSolution(question);

  let aiHint = null;
  try {
    aiHint = await generateGeminiHint({ code, question, hintLevel, fallback: found });
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
    hintLevel,
    hint,
    nextPrompt: "Pehle khud ek chhota badlav karke try karo, phir batao kya hua."
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "SocratesLive Base", geminiEnabled: Boolean(GEMINI_API_KEY) });
});

app.listen(PORT, () => {
  console.log(`SocratesLive backend running on http://localhost:${PORT}`);
});