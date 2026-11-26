import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5050;

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

app.post("/api/hint", (req, res) => {
  const { code = "", question = "", hintLevel = 1 } = req.body || {};

  if (!code.trim() && !question.trim()) {
    return res.status(400).json({
      error: "Kuch code ya doubt toh daal bhai!"
    });
  }

  const found = findStarterIssue(code);

  if (isAskingForDirectSolution(question)) {
    return res.json({
      blockedDirectAnswer: true,
      lineNumber: found.lineNumber,
      hintLevel,
      hint: `Seedha solution nahi milega 🙂 — Level ${hintLevel} hint: ${found.hint}`,
      nextPrompt: "Pehle khud ek chhota badlav karke try karo, phir batao kya hua."
    });
  }

  return res.json({
    blockedDirectAnswer: false,
    lineNumber: found.lineNumber,
    hintLevel,
    hint: `Level ${hintLevel} Hint: ${found.hint}`,
    nextPrompt: question.trim()
      ? `Tumne poocha: "${question.trim()}" — iske hisaab se pehla step kya hona chahiye?`
      : "Is line ko sudharne ke baad output mein kya badlav aana chahiye?"
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "SocratesLive Base" });
});

app.listen(PORT, () => {
  console.log(`SocratesLive base backend running on http://localhost:${PORT}`);
});
