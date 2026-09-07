const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ensureDir, writeTextFile, getNowTag } = require("../io");
const { createHandsFreeProxy, PROXY_CAPABILITY } = require("./proxy-server");
const { openPathFromUrl, parseOriginList } = require("./public-rewrite");

const TOOL_ROOT = path.resolve(__dirname, "..", "..");
const OVERLAY_PATH = path.join(__dirname, "overlay-client.js");
const CONTAINER_NAME = "browser-emu-hands-free-tunnel";
const LEGACY_CONTAINER_NAME = "browser-emu-phone-tunnel";
const STATE_NAME = "last-hands-free.json";

function statePath(outputDir) {
  return path.join(outputDir, STATE_NAME);
}

function readState(outputDir) {
  const file = statePath(outputDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeState(outputDir, data) {
  writeTextFile(statePath(outputDir), JSON.stringify(data, null, 2));
}

function runDirFrom(outputDir, runTag) {
  return path.join(outputDir, "runs", runTag);
}

function pathsFor(runDir) {
  return {
    holdAnswer: path.join(runDir, "hold-answer.json"),
    version: path.join(runDir, "phone-version.txt"),
    status: path.join(runDir, "phone-status.txt"),
    screenshot: path.join(runDir, "hold-composite.jpg"),
    annotation: path.join(runDir, "hold-annotation.png")
  };
}

function setStatus(runDir, state) {
  const files = pathsFor(runDir);
  writeTextFile(files.status, state === "progress" ? "progress" : "listening");
}

function bumpVersion(runDir) {
  const files = pathsFor(runDir);
  const version = String(Date.now());
  writeTextFile(files.version, version);
  return version;
}

function saveDataUrl(dataUrl, destPath) {
  if (!dataUrl || typeof dataUrl !== "string") return false;
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);
  if (!match) return false;
  fs.writeFileSync(destPath, Buffer.from(match[2], "base64"));
  return true;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function docker(args, opts = {}) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    ...opts
  });
}

function containerRunning() {
  const result = docker(["inspect", "-f", "{{.State.Running}}", CONTAINER_NAME]);
  return String(result.stdout || "").trim() === "true";
}

function stopTunnel() {
  docker(["rm", "-f", CONTAINER_NAME]);
  docker(["rm", "-f", LEGACY_CONTAINER_NAME]);
}

function startTunnel({ proxyPort, dockerHost }) {
  stopTunnel();
  const result = docker([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "cloudflare/cloudflared:latest",
    "tunnel",
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--url",
    `http://${dockerHost}:${proxyPort}`
  ]);
  if (result.status !== 0) {
    throw new Error(`docker run failed: ${String(result.stderr || result.stdout || "unknown")}`);
  }
}

function readTunnelUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = docker(["logs", CONTAINER_NAME]);
    const text = `${result.stdout || ""}\n${result.stderr || ""}`;
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) return match[0];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error("Timed out waiting for Cloudflare tunnel URL in docker logs.");
}

function startProxy(options) {
  return createHandsFreeProxy({
    origin: options.origin,
    hostHeader: options.hostHeader,
    stripScripts: (options.stripScripts || []).filter(Boolean),
    overlayJs: options.overlayJs,
    files: pathsFor(options.runDir),
    viteOrigin: options.viteOrigin,
    extraOrigins: options.extraOrigins,
    extraHosts: options.extraHosts,
    saveDataUrl,
    writeTextFile
  });
}

function isPublicTunnelHealthy(publicUrl) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL("/__emu/health", String(publicUrl || ""));
    } catch {
      resolve(false);
      return;
    }
    const req = https.get(url, { timeout: 4000, headers: { "User-Agent": "browser-emu-health" } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function isServeHealthy(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/__emu/health", timeout: 1500 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          resolve(Boolean(body.ok) && body.capability === PROXY_CAPABILITY);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStripScripts(args) {
  const raw = args.stripScript || args.stripScripts || "";
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveReviewOptions({ args, config, outputDir }) {
  const runTag = args.runTag || config.runTag || `hands-free-${getNowTag()}`;
  const origin = String(args.origin || config.phoneOrigin || config.handsFreeOrigin || "http://127.0.0.1").replace(/\/$/, "");
  let hostHeader = String(args.hostHeader || config.phoneHostHeader || config.handsFreeHostHeader || "");
  if (!hostHeader) {
    try {
      hostHeader = new URL(args.url || config.url || origin).hostname;
    } catch {
      hostHeader = "localhost";
    }
  }
  const dockerHost = String(args.dockerHost || config.phoneDockerHost || config.handsFreeDockerHost || "host.docker.internal");
  const holdTimeoutMs = Math.max(60000, Number(args.holdTimeoutMs || 600000));
  const viteOrigin = String(args.viteOrigin || config.handsFreeViteOrigin || "http://127.0.0.1:5173").replace(/\/$/, "");
  const extraOrigins = parseOriginList([
    args.backendOrigin || config.handsFreeBackendOrigin,
    args.backendV2Origin || config.handsFreeBackendV2Origin,
    args.extraOrigin || args.extraOrigins || config.handsFreeExtraOrigins
  ]);
  const extraHosts = String(args.extraHost || args.extraHosts || config.handsFreeExtraHosts || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (args.backendHost || config.handsFreeBackendHost) extraHosts[0] = String(args.backendHost || config.handsFreeBackendHost).replace(/^https?:\/\//, "");
  if (args.backendV2Host || config.handsFreeBackendV2Host) extraHosts[1] = String(args.backendV2Host || config.handsFreeBackendV2Host).replace(/^https?:\/\//, "");
  const sourceUrl = args.url || config.url || origin;
  return {
    runTag,
    origin,
    hostHeader,
    dockerHost,
    holdTimeoutMs,
    viteOrigin,
    extraOrigins,
    extraHosts,
    openPath: openPathFromUrl(sourceUrl),
    stripScripts: parseStripScripts(args),
    outputDir,
    runDir: runDirFrom(outputDir, runTag)
  };
}

async function serveReview(options) {
  const overlayJs = fs.readFileSync(OVERLAY_PATH, "utf8");
  ensureDir(options.runDir);
  const holdFile = pathsFor(options.runDir).holdAnswer;
  if (fs.existsSync(holdFile)) fs.unlinkSync(holdFile);
  setStatus(options.runDir, "listening");
  bumpVersion(options.runDir);

  const port = await findFreePort();
  const server = startProxy({
    origin: options.origin,
    hostHeader: options.hostHeader,
    stripScripts: options.stripScripts,
    runDir: options.runDir,
    overlayJs,
    viteOrigin: options.viteOrigin,
    extraOrigins: options.extraOrigins,
    extraHosts: options.extraHosts
  });

  await new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", resolve);
    server.on("error", reject);
  });

  startTunnel({ proxyPort: port, dockerHost: options.dockerHost });
  const publicUrl = readTunnelUrl(90000);
  writeState(options.outputDir, {
    runTag: options.runTag,
    runDir: options.runDir,
    publicUrl,
    proxyPort: port,
    origin: options.origin,
    hostHeader: options.hostHeader,
    capability: PROXY_CAPABILITY,
    viteOrigin: options.viteOrigin,
    extraOrigins: options.extraOrigins,
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
  writeTextFile(path.join(options.outputDir, "last-hands-free-url.txt"), publicUrl);
  const openPath = options.openPath && options.openPath !== "/" ? options.openPath : "/";
  console.log(`HANDS_FREE_URL=${publicUrl}`);
  console.log(`PHONE_REVIEW_URL=${publicUrl}`);
  console.log(`HANDS_FREE_OPEN=${publicUrl}${openPath}`);
  console.log(`HANDS_FREE_SERVING port=${port} host=${options.hostHeader}`);
  console.log(`HANDS_FREE_REWRITE vite=${options.viteOrigin} extra=${(options.extraOrigins || []).join(",")}`);
  return { server, publicUrl, port };
}

function spawnServeDetached(argsList) {
  const child = spawn(process.execPath, [path.join(TOOL_ROOT, "emulator.js"), ...argsList], {
    cwd: TOOL_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

async function ensureServing(options, rawArgv) {
  const existing = readState(options.outputDir);
  if (
    existing &&
    existing.proxyPort &&
    existing.capability === PROXY_CAPABILITY &&
    (await isServeHealthy(existing.proxyPort)) &&
    (await isPublicTunnelHealthy(existing.publicUrl))
  ) {
    console.log(`HANDS_FREE_URL=${existing.publicUrl}`);
    console.log(`PHONE_REVIEW_URL=${existing.publicUrl}`);
    console.log("HANDS_FREE_REUSED existing tunnel");
    return existing;
  }
  if (existing && existing.proxyPort) {
    console.log("HANDS_FREE_RESTART proxy rewrite updated");
    stopReview(options.outputDir);
  }

  const passArgs = ["hands-free", "--serve"];
  const keep = [
    "config",
    "origin",
    "hostHeader",
    "dockerHost",
    "runTag",
    "stripScript",
    "url",
    "viteOrigin",
    "extraOrigin",
    "extraOrigins",
    "extraHost",
    "backendOrigin",
    "backendV2Origin",
    "backendHost",
    "backendV2Host"
  ];
  keep.forEach((key) => {
    if (rawArgv[key] !== undefined && rawArgv[key] !== true) {
      const value = key === "config" ? path.resolve(String(rawArgv[key])) : String(rawArgv[key]);
      passArgs.push(`--${key}`, value);
    }
  });
  spawnServeDetached(passArgs);

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const state = readState(options.outputDir);
    if (state && state.publicUrl && state.proxyPort && (await isServeHealthy(state.proxyPort))) {
      console.log(`HANDS_FREE_URL=${state.publicUrl}`);
      console.log(`PHONE_REVIEW_URL=${state.publicUrl}`);
      return state;
    }
    await sleep(2000);
  }
  throw new Error("hands-free serve did not become ready (docker tunnel or proxy failed).");
}

async function waitForHold(options) {
  const files = pathsFor(options.runDir);
  if (fs.existsSync(files.holdAnswer)) fs.unlinkSync(files.holdAnswer);
  setStatus(options.runDir, "listening");
  const deadline = Date.now() + options.holdTimeoutMs;
  console.log(`WAITING_HANDS_FREE_HOLD until ${new Date(deadline).toISOString()}`);
  while (Date.now() < deadline) {
    if (fs.existsSync(files.holdAnswer)) {
      const raw = fs.readFileSync(files.holdAnswer, "utf8");
      console.log("HANDS_FREE_HOLD_RECEIVED");
      console.log("PHONE_HOLD_RECEIVED");
      console.log(raw);
      return JSON.parse(raw);
    }
    await sleep(4000);
  }
  console.log("HANDS_FREE_HOLD_TIMEOUT");
  console.log("PHONE_HOLD_TIMEOUT");
  const error = new Error("hands-free hold timed out");
  error.exitCode = 1;
  throw error;
}

function reloadReview({ outputDir, args, state }) {
  const runTag = args.runTag || (state && state.runTag);
  if (!runTag) throw new Error("hands-free-reload needs --runTag or a running hands-free session.");
  const runDir = runDirFrom(outputDir, runTag);
  const nextState = String(args.state || "listening") === "progress" ? "progress" : "listening";
  setStatus(runDir, nextState);
  const version = bumpVersion(runDir);
  console.log(`HANDS_FREE_RELOAD state=${nextState} v=${version}`);
}

function stopReview(outputDir) {
  const state = readState(outputDir);
  stopTunnel();
  if (state && state.pid && state.pid !== process.pid) {
    try {
      process.kill(state.pid);
    } catch {
      // already gone
    }
  }
  console.log("HANDS_FREE_STOPPED");
}

function normalizeHandsFreeCommand(command) {
  if (command === "phone-review") return "hands-free";
  if (command === "phone-reload") return "hands-free-reload";
  if (command === "phone-stop") return "hands-free-stop";
  return command;
}

async function handlePhoneReviewCommand({ command, args, config, outputDir }) {
  const resolved = normalizeHandsFreeCommand(command);
  const options = resolveReviewOptions({ args, config, outputDir });
  if (resolved === "hands-free-stop") {
    stopReview(outputDir);
    return { status: "stopped" };
  }
  if (resolved === "hands-free-reload") {
    reloadReview({ outputDir, args, state: readState(outputDir) });
    return { status: "reloaded" };
  }
  if (resolved === "hands-free" && args.serve) {
    await serveReview(options);
    await new Promise(() => {});
  }
  const state = await ensureServing(options, args);
  if (args.startOnly) {
    return { status: "started", publicUrl: state.publicUrl };
  }
  options.runTag = state.runTag || options.runTag;
  options.runDir = state.runDir || options.runDir;
  const answer = await waitForHold(options);
  return { status: "received", answer };
}

const HANDS_FREE_COMMANDS = new Set([
  "hands-free",
  "hands-free-reload",
  "hands-free-stop",
  "phone-review",
  "phone-reload",
  "phone-stop"
]);

module.exports = {
  handlePhoneReviewCommand,
  PHONE_REVIEW_COMMANDS: HANDS_FREE_COMMANDS,
  HANDS_FREE_COMMANDS
};
