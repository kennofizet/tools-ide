const fs = require("fs");
const path = require("path");

function holdConsumedPath(runDir) {
  return path.join(runDir, "hold-consumed.txt");
}

function holdAnswerPath(runDir) {
  return path.join(runDir, "hold-answer.json");
}

function readHoldAnswer(runDir) {
  const file = holdAnswerPath(runDir);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function holdStamp(answer) {
  return String((answer && answer.submittedAt) || "");
}

function readConsumedStamp(runDir) {
  const file = holdConsumedPath(runDir);
  if (!file || !fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function readUnconsumedHold(runDir) {
  const answer = readHoldAnswer(runDir);
  const stamp = holdStamp(answer);
  if (!answer || !stamp) return null;
  if (stamp === readConsumedStamp(runDir)) return null;
  return answer;
}

function consumeHold(runDir, answer) {
  const stamp = holdStamp(answer) || String(Date.now());
  fs.writeFileSync(holdConsumedPath(runDir), stamp);
  return stamp;
}

function lastHandsFreeState(toolRoot) {
  const file = path.join(toolRoot, "output", "last-hands-free.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  holdAnswerPath,
  holdConsumedPath,
  readHoldAnswer,
  readUnconsumedHold,
  consumeHold,
  lastHandsFreeState
};
