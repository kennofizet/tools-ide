const fs = require("fs");
const path = require("path");
const { writeTextFile } = require("./io");

const FILE_NAME = "review-mode.local.json";

function reviewModePath(outputDir) {
  return path.join(outputDir, FILE_NAME);
}

function normalizeMode(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["desktop", "pc", "this-computer", "this_computer", "cdp", "edge"].includes(v)) {
    return "desktop";
  }
  if (["hands-free", "handsfree", "hands_free", "other-device", "other_device", "phone", "remote"].includes(v)) {
    return "hands-free";
  }
  return "";
}

function readReviewMode(outputDir) {
  const file = reviewModePath(outputDir);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const mode = normalizeMode(data.mode);
    if (!mode) return null;
    return { ...data, mode, path: file };
  } catch {
    return null;
  }
}

function writeReviewMode(outputDir, mode, source) {
  const normalized = normalizeMode(mode);
  if (!normalized) {
    throw new Error("Review mode must be 'desktop' or 'hands-free'.");
  }
  const payload = {
    mode: normalized,
    source: source || "cli",
    savedAt: new Date().toISOString(),
    label: normalized === "hands-free"
      ? "another device (hands-free)"
      : "this computer (desktop Edge)"
  };
  writeTextFile(reviewModePath(outputDir), JSON.stringify(payload, null, 2));
  return payload;
}

function requiredMessage() {
  return [
    "REVIEW_MODE_REQUIRED",
    "Ask the human before testing or collecting feedback:",
    "  1) This computer — desktop Edge CDP hold",
    "  2) Another device — hands-free mode (Docker tunnel + on-device form)",
    "Save the answer with:",
    "  node emulator.js review-mode --mode desktop",
    "  node emulator.js review-mode --mode hands-free",
    "Or pass --reviewMode desktop|hands-free once. It is remembered in output/review-mode.local.json."
  ].join("\n");
}

function ensureReviewMode({ args, config, outputDir, command }) {
  if (command === "help" || command === "review-mode") {
    return readReviewMode(outputDir);
  }

  const fromArg = normalizeMode(args.reviewMode || (command === "review-mode" ? args.mode : ""));
  if (fromArg) {
    const saved = writeReviewMode(outputDir, fromArg, "cli");
    console.log(`REVIEW_MODE_SAVED mode=${saved.mode} (${saved.label})`);
    return saved;
  }

  const saved = readReviewMode(outputDir);
  if (saved) {
    console.log(`REVIEW_MODE_USING mode=${saved.mode} (${saved.label})`);
    return saved;
  }

  const fromConfig = normalizeMode(config.reviewMode);
  if (fromConfig) {
    const written = writeReviewMode(outputDir, fromConfig, "config");
    console.log(`REVIEW_MODE_SAVED mode=${written.mode} (${written.label})`);
    return written;
  }

  const error = new Error(requiredMessage());
  error.exitCode = 2;
  throw error;
}

function assertHoldPath({ command, actionType, mode }) {
  if (!mode) return;
  const type = String(actionType || "").trim();
  const isCdpHold = command === "action" && (type === "hold" || type === "holdForUserAnswer");
  const isHandsFreeCmd = command === "hands-free" || command === "hands-free-reload" || command === "phone-review" || command === "phone-reload";

  if (mode === "hands-free" && isCdpHold) {
    const error = new Error(
      "Hands-free mode is saved. CDP hold cannot reach another device.\nRun: node emulator.js hands-free --origin http://127.0.0.1 --hostHeader <vhost> --holdTimeoutMs 600000 --runTag hands-free-1"
    );
    error.exitCode = 2;
    throw error;
  }

  if (mode === "desktop" && isHandsFreeCmd) {
    const error = new Error(
      "Desktop mode is saved. Collect feedback with --type holdForUserAnswer on this computer.\nTo switch: node emulator.js review-mode --mode hands-free"
    );
    error.exitCode = 2;
    throw error;
  }
}

function handleReviewModeCommand({ args, outputDir }) {
  const requested = normalizeMode(args.mode || args.reviewMode);
  if (!requested) {
    const saved = readReviewMode(outputDir);
    if (!saved) {
      console.log(requiredMessage());
      return { status: "missing" };
    }
    console.log(`REVIEW_MODE_USING mode=${saved.mode} (${saved.label})`);
    console.log(`REVIEW_MODE_FILE=${saved.path}`);
    return saved;
  }
  const saved = writeReviewMode(outputDir, requested, "review-mode");
  console.log(`REVIEW_MODE_SAVED mode=${saved.mode} (${saved.label})`);
  if (saved.mode === "hands-free") {
    console.log("Next: node emulator.js hands-free --origin http://127.0.0.1 --hostHeader <vhost> --holdTimeoutMs 600000 --runTag hands-free-1");
  } else {
    console.log("Next: node emulator.js action --type holdForUserAnswer --selector <zone> --holdTimeoutMs 600000 --runTag desktop-hold-1");
  }
  return saved;
}

module.exports = {
  FILE_NAME,
  normalizeMode,
  readReviewMode,
  writeReviewMode,
  ensureReviewMode,
  assertHoldPath,
  handleReviewModeCommand,
  requiredMessage
};
