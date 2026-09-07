const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error("Usage: node run-evaluate-file.js <script.js> -- <emulator args>");
  process.exit(1);
}

const splitAt = process.argv.indexOf("--");
const emulatorArgs = splitAt === -1 ? [] : process.argv.slice(splitAt + 1);
const script = fs.readFileSync(path.resolve(scriptPath), "utf8");

const result = spawnSync(
  process.execPath,
  ["emulator.js", ...emulatorArgs, "--script", script],
  { stdio: "inherit", cwd: __dirname, shell: false },
);

process.exit(result.status == null ? 1 : result.status);
