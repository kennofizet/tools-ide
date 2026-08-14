const fs = require("fs");
const path = require("path");

function loadCaseFile(casePath) {
  const resolved = path.resolve(casePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Case file not found: ${resolved}`);
  }
  const content = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(content);
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  return {
    path: resolved,
    data: parsed,
    actions
  };
}

module.exports = {
  loadCaseFile
};

