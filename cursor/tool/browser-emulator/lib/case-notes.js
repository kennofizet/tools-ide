const fs = require("fs");
const path = require("path");

function toStepText(action) {
  if (!action || !action.type) return "unknown step";
  if (action.type === "fill") {
    return `fill ${action.selector || "(missing-selector)"}`;
  }
  if (action.type === "click") {
    return `click ${action.selector || "(missing-selector)"}`;
  }
  if (action.type === "waitForSelector") {
    return `wait for ${action.selector || "(missing-selector)"}`;
  }
  if (action.type === "waitForTimeout") {
    return `wait ${Number(action.ms || 500)}ms`;
  }
  if (action.type === "press") {
    return `press ${action.key || "(missing-key)"}`;
  }
  if (action.type === "goto") {
    return `goto ${action.url || "(missing-url)"}`;
  }
  return action.type;
}

function saveCaseNote({
  notesPath,
  caseKey,
  targetUrl,
  action,
  runTag,
  finalUrl,
  noteText,
  ensureDirFn
}) {
  const resolved = path.resolve(notesPath);
  const key = String(caseKey || "").trim();
  if (!key) {
    throw new Error("saveCaseNote requires caseKey");
  }

  const initial = {
    version: 1,
    updatedAt: new Date().toISOString(),
    cases: {}
  };

  let data = initial;
  if (fs.existsSync(resolved)) {
    const content = fs.readFileSync(resolved, "utf8");
    data = JSON.parse(content);
    if (!data || typeof data !== "object") data = initial;
    if (!data.cases || typeof data.cases !== "object") data.cases = {};
  }

  const now = new Date().toISOString();
  const current = data.cases[key] || {
    key,
    createdAt: now,
    updatedAt: now,
    targetUrl: targetUrl || "",
    flow: [],
    notes: []
  };

  if (!current.targetUrl && targetUrl) {
    current.targetUrl = targetUrl;
  }
  current.updatedAt = now;

  current.flow.push({
    step: current.flow.length + 1,
    text: toStepText(action),
    action,
    runTag: runTag || null,
    finalUrl: finalUrl || null,
    at: now
  });

  if (noteText && String(noteText).trim()) {
    current.notes.push({
      text: String(noteText).trim(),
      at: now
    });
  }

  data.updatedAt = now;
  data.cases[key] = current;

  ensureDirFn(path.dirname(resolved));
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2), "utf8");
  return resolved;
}

module.exports = {
  saveCaseNote
};
