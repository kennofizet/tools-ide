const fs = require("fs");
const path = require("path");

const TOOL_ROOT = path.resolve(__dirname, "..", "..", "cursor", "tool", "browser-emulator");
const { readUnconsumedHold, consumeHold, lastHandsFreeState } = require(path.join(TOOL_ROOT, "lib", "phone-review", "hold-queue"));

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

(async () => {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    input = {};
  }
  if (input.status && input.status !== "completed") {
    process.stdout.write("{}\n");
    return;
  }
  const state = lastHandsFreeState(TOOL_ROOT);
  if (!state || !state.runDir || !fs.existsSync(state.runDir)) {
    process.stdout.write("{}\n");
    return;
  }
  const answer = readUnconsumedHold(state.runDir);
  if (!answer) {
    process.stdout.write("{}\n");
    return;
  }
  consumeHold(state.runDir, answer);
  const decision = String(answer.decision || "feedback");
  const note = String(answer.noteText || "").trim().slice(0, 240);
  const followup = [
    "Hands-free feedback arrived while the agent was not in listen. Auto-start now.",
    `Read ${path.join(state.runDir, "hold-answer.json")}.`,
    `decision=${decision}.`,
    note ? `note=${note}` : "no note",
    "Apply the feedback. Overlay is IN PROGRESS. Do not show “Agent is not in listen.”"
  ].join(" ");
  process.stdout.write(`${JSON.stringify({ followup_message: followup })}\n`);
})().catch(() => {
  process.stdout.write("{}\n");
});
