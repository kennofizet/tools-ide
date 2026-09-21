const fs = require("fs");
const os = require("os");
const path = require("path");
const { readUnconsumedHold, consumeHold } = require("../lib/phone-review/hold-queue");

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "emu-hold-queue-"));
const answerFile = path.join(runDir, "hold-answer.json");
const answer = {
  decision: "feedback",
  noteText: "queued",
  submittedAt: "2026-09-09T00:00:00.000Z"
};
fs.writeFileSync(answerFile, JSON.stringify(answer));
if (!readUnconsumedHold(runDir)) throw new Error("new hold should be unconsumed");
consumeHold(runDir, answer);
if (readUnconsumedHold(runDir)) throw new Error("consumed hold should be skipped");
const next = { ...answer, submittedAt: "2026-09-09T00:01:00.000Z" };
fs.writeFileSync(answerFile, JSON.stringify(next));
if (!readUnconsumedHold(runDir)) throw new Error("new submittedAt should be unconsumed");
console.log("HOLD_QUEUE_OK");
