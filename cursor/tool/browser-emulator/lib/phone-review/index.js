const fs = require("fs");
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { ensureDir, writeTextFile, getNowTag } = require("../io");
const { createHandsFreeProxy, PROXY_CAPABILITY } = require("./proxy-server");
const { openPathFromUrl, parseOriginList } = require("./public-rewrite");
const { consumeHold, readUnconsumedHold } = require("./hold-queue");
const { resolveHubOptions, checkHubHealth, publishLive, publishTask, publishHoldReceived, holdIdeTask, ensureIdeWorking, overlayPreamble, attachLiveChannel } = require("../hub-live");

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
    annotation: path.join(runDir, "hold-annotation.png"),
    viteSeen: path.join(runDir, "vite-seen-modules.json"),
    waiting: path.join(runDir, "phone-waiting.txt"),
    holdConsumed: path.join(runDir, "hold-consumed.txt"),
    box1Answer: path.join(runDir, "box1-answer.txt")
  };
}

function holdFollowupState(decision, waiting) {
  if (!waiting) return "progress";
  if (decision === "accept") return "listening";
  return "progress";
}

function isHoldWaitActive(runDir) {
  const file = pathsFor(runDir).waiting;
  return Boolean(file && fs.existsSync(file));
}

function setHoldWait(runDir, active) {
  const file = pathsFor(runDir).waiting;
  if (active) writeTextFile(file, "1");
  else if (fs.existsSync(file)) fs.unlinkSync(file);
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

function readVersion(runDir) {
  const files = pathsFor(runDir);
  if (fs.existsSync(files.version)) return fs.readFileSync(files.version, "utf8").trim() || "0";
  return "0";
}

function overlayRev() {
  try {
    return String(Math.round(fs.statSync(OVERLAY_PATH).mtimeMs));
  } catch {
    return "";
  }
}

function readBox1Answer(runDir) {
  const file = pathsFor(runDir).box1Answer;
  if (!file || !fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function writeBox1Answer(runDir, text) {
  writeTextFile(pathsFor(runDir).box1Answer, String(text || "").trim());
}

function livePayload(runDir, state, extra = {}) {
  const bump = extra.bump !== false;
  const answer = extra.answer != null
    ? String(extra.answer)
    : (runDir ? readBox1Answer(runDir) : "");
  const payload = {
    state: state === "progress" ? "progress" : "listening",
    v: extra.v || (runDir ? (bump ? bumpVersion(runDir) : readVersion(runDir)) : String(Date.now())),
    runTag: extra.runTag || "",
    tool: "browser-emulator",
    liveUpdate: true,
    reload: false
  };
  if (answer) payload.answer = answer;
  if (extra.swapOverlay) {
    payload.overlayRev = overlayRev();
    payload.swapOverlay = true;
  }
  return payload;
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
    writeTextFile,
    handleLiveUpgrade: options.handleLiveUpgrade,
    liveEnabled: options.liveEnabled,
    onHold: options.onHold,
    getOverlayJs: options.getOverlayJs,
    getOverlayRev: options.getOverlayRev,
    holdToken: options.holdToken,
    insecureUpstream: options.insecureUpstream
  });
}

function httpsHealthRequest(options) {
  return new Promise((resolve) => {
    const req = https.get(options, (res) => {
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

function resolveIpv4(hostname) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    resolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || !addresses.length) resolve("");
      else resolve(addresses[0]);
    });
  });
}

async function isPublicTunnelHealthy(publicUrl) {
  let url;
  try {
    url = new URL("/__emu/health", String(publicUrl || ""));
  } catch {
    return false;
  }
  const headers = { "User-Agent": "browser-emu-health" };
  const port = Number(url.port || 443);
  const pathName = `${url.pathname}${url.search}`;
  if (
    await httpsHealthRequest({
      hostname: url.hostname,
      port,
      path: pathName,
      timeout: 4000,
      family: 4,
      headers,
      servername: url.hostname
    })
  ) {
    return true;
  }
  const ip = await resolveIpv4(url.hostname);
  if (!ip) return false;
  return httpsHealthRequest({
    hostname: ip,
    port,
    path: pathName,
    timeout: 6000,
    headers: { ...headers, Host: url.hostname },
    servername: url.hostname
  });
}

async function waitUntilPublicHealthy(publicUrl, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPublicTunnelHealthy(publicUrl)) return true;
    await sleep(2000);
  }
  return false;
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

function parseBoolFlag(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value == null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function makeHoldToken() {
  return crypto.randomBytes(24).toString("hex");
}

function withHoldQuery(publicUrl, openPath, holdToken) {
  const base = `${String(publicUrl || "").replace(/\/$/, "")}${openPath && openPath !== "/" ? openPath : "/"}`;
  if (!holdToken) return base;
  try {
    const url = new URL(base);
    url.searchParams.set("emu_hold", holdToken);
    return url.toString();
  } catch {
    const join = base.includes("?") ? "&" : "?";
    return `${base}${join}emu_hold=${encodeURIComponent(holdToken)}`;
  }
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
  const hub = resolveHubOptions({ args, config });
  const existing = readState(outputDir);
  const holdToken = String(args.holdToken || config.handsFreeHoldToken || (existing && existing.holdToken) || makeHoldToken());
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
    runDir: runDirFrom(outputDir, runTag),
    hub,
    proxyPort: Number(args.proxyPort || 0) || 0,
    keepTunnel: args.keepTunnel === true || String(args.keepTunnel || "") === "true",
    publicUrl: String(args.publicUrl || ""),
    holdToken,
    insecureUpstream: parseBoolFlag(args.insecureUpstream ?? config.handsFreeInsecureUpstream, false)
  };
}

async function serveReview(options) {
  ensureDir(options.runDir);
  const holdFile = pathsFor(options.runDir).holdAnswer;
  if (!options.keepTunnel && fs.existsSync(holdFile)) fs.unlinkSync(holdFile);
  if (!options.keepTunnel) {
    setStatus(options.runDir, "listening");
    bumpVersion(options.runDir);
  }

  const hubHealth = await checkHubHealth(options.hub || { enabled: false, ok: false });
  const liveRef = { channel: null };
  function overlayFromDisk() {
    return `${overlayPreamble(hubHealth.ok, overlayRev())}${fs.readFileSync(OVERLAY_PATH, "utf8")}`;
  }
  const overlayJs = overlayFromDisk();
  const port = Number(options.proxyPort) > 0 ? Number(options.proxyPort) : await findFreePort();
  const server = startProxy({
    origin: options.origin,
    hostHeader: options.hostHeader,
    stripScripts: options.stripScripts,
    runDir: options.runDir,
    overlayJs,
    viteOrigin: options.viteOrigin,
    extraOrigins: options.extraOrigins,
    extraHosts: options.extraHosts,
    liveEnabled: hubHealth.ok,
    holdToken: options.holdToken,
    insecureUpstream: options.insecureUpstream,
    getOverlayJs: overlayFromDisk,
    getOverlayRev: overlayRev,
    handleLiveUpgrade: (req, socket, head) => {
      if (liveRef.channel && liveRef.channel.handleUpgrade) liveRef.channel.handleUpgrade(req, socket, head);
      else socket.destroy();
    },
    onHold: (payload) => {
      const waiting = isHoldWaitActive(options.runDir);
      const nextState = holdFollowupState(payload.decision, waiting);
      setStatus(options.runDir, nextState);
      const live = livePayload(options.runDir, nextState, { runTag: options.runTag, bump: false });
      publishHoldReceived({
        channel: liveRef.channel,
        hubOptions: hubHealth,
        payload,
        nextState,
        waiting,
        runTag: options.runTag,
        live
      })
        .then((sent) => {
          if (sent) {
            console.log(`HANDS_FREE_HOLD waiting=${waiting ? "1" : "0"} decision=${payload.decision || ""}`);
            return ensureIdeWorking(hubHealth);
          }
          if (!hubHealth.ok) bumpVersion(options.runDir);
          return null;
        })
        .catch(() => {
          if (!hubHealth.ok) bumpVersion(options.runDir);
        });
    }
  });
  liveRef.channel = attachLiveChannel(server, {
    hubOptions: hubHealth,
    files: pathsFor(options.runDir),
    runDir: options.runDir,
    setStatus,
    bumpVersion,
    getOverlayRev: overlayRev
  });

  await new Promise((resolve, reject) => {
    server.listen(port, "0.0.0.0", resolve);
    server.on("error", reject);
  });

  let hubLive = false;
  if (liveRef.channel.enabled) {
    try {
      hubLive = Boolean(await liveRef.channel.connect());
    } catch {
      hubLive = false;
    }
  }
  console.log(hubLive ? `HUB_LIVE_ON ${hubHealth.wsUrl}` : "HUB_LIVE_OFF");
  if (hubLive) {
    await ensureIdeWorking(hubHealth);
  } else {
    console.log("IDE_WORKING_SKIP hub offline");
  }

  let publicUrl = String(options.publicUrl || "");
  if (options.keepTunnel && publicUrl) {
    console.log("HANDS_FREE_KEEP_TUNNEL");
  } else {
    startTunnel({ proxyPort: port, dockerHost: options.dockerHost });
    publicUrl = readTunnelUrl(90000);
    const ready = await waitUntilPublicHealthy(publicUrl, 45000);
    console.log(ready ? "HANDS_FREE_TUNNEL_READY" : "HANDS_FREE_TUNNEL_NOT_READY");
  }
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
    holdToken: options.holdToken,
    hubLive,
    hubUrl: hubHealth.httpUrl || "",
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
  writeTextFile(path.join(options.outputDir, "last-hands-free-url.txt"), publicUrl);
  const openPath = options.openPath && options.openPath !== "/" ? options.openPath : "/";
  const openUrl = withHoldQuery(publicUrl, openPath, options.holdToken);
  console.log(`HANDS_FREE_URL=${publicUrl}`);
  console.log(`PHONE_REVIEW_URL=${publicUrl}`);
  console.log(`HANDS_FREE_HOLD_TOKEN=${options.holdToken}`);
  console.log(`HANDS_FREE_OPEN=${openUrl}`);
  console.log("HANDS_FREE_CAPABILITY_URL treat HANDS_FREE_OPEN as a secret share link (holds agent wake)");
  console.log(`HANDS_FREE_SERVING port=${port} host=${options.hostHeader}`);
  console.log(`HANDS_FREE_REWRITE vite=${options.viteOrigin} extra=${(options.extraOrigins || []).join(",")}`);
  if (options.insecureUpstream) {
    console.log("HANDS_FREE_INSECURE_UPSTREAM rejectUnauthorized=false");
  }
  if (hubLive) {
    await publishTask(hubHealth, {
      title: options.keepTunnel ? "Thinking" : "Hands-free serving",
      content: options.keepTunnel
        ? "Proxy restarted. Agent is continuing."
        : `Open ${openPath} on the other device.`,
      stream: `serving ${publicUrl}${openPath}`,
      kind: options.keepTunnel ? "thinking" : "log",
      phase: options.keepTunnel ? "work" : "wait",
      runTag: options.runTag
    });
  }
  return { server, publicUrl, port, hubLive };
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
    if (existing.holdToken) {
      console.log(`HANDS_FREE_HOLD_TOKEN=${existing.holdToken}`);
      console.log(`HANDS_FREE_OPEN=${withHoldQuery(existing.publicUrl, options.openPath || "/", existing.holdToken)}`);
    }
    console.log("HANDS_FREE_REUSED existing tunnel");
    return existing;
  }
  if (existing && existing.proxyPort && existing.publicUrl && (await isPublicTunnelHealthy(existing.publicUrl))) {
    console.log("HANDS_FREE_RESTART_PROXY keep-tunnel");
    if (existing.pid && existing.pid !== process.pid) {
      try {
        process.kill(existing.pid);
      } catch {
        // already gone
      }
    }
    await sleep(1200);
    const passArgs = ["hands-free", "--serve", "--keepTunnel", "true", "--proxyPort", String(existing.proxyPort), "--publicUrl", existing.publicUrl];
    if (existing.holdToken) passArgs.push("--holdToken", String(existing.holdToken));
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
      "backendV2Host",
      "hubUrl",
      "hubToken",
      "hubRoom",
      "noHub",
      "holdToken",
      "insecureUpstream"
    ];
    keep.forEach((key) => {
      if (rawArgv[key] !== undefined && rawArgv[key] !== true) {
        const value = key === "config" ? path.resolve(String(rawArgv[key])) : String(rawArgv[key]);
        passArgs.push(`--${key}`, value);
      } else if (rawArgv[key] === true && key === "insecureUpstream") {
        passArgs.push(`--${key}`, "true");
      }
    });
    spawnServeDetached(passArgs);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const state = readState(options.outputDir);
      if (state && state.proxyPort === existing.proxyPort && state.capability === PROXY_CAPABILITY && (await isServeHealthy(state.proxyPort))) {
        console.log(`HANDS_FREE_URL=${state.publicUrl}`);
        console.log(`PHONE_REVIEW_URL=${state.publicUrl}`);
        if (state.holdToken) {
          console.log(`HANDS_FREE_HOLD_TOKEN=${state.holdToken}`);
          console.log(`HANDS_FREE_OPEN=${withHoldQuery(state.publicUrl, options.openPath || "/", state.holdToken)}`);
        }
        return state;
      }
      await sleep(1000);
    }
    console.log("HANDS_FREE_RESTART_PROXY fallback new tunnel");
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
    "backendV2Host",
    "hubUrl",
    "hubToken",
    "hubRoom",
    "noHub",
    "proxyPort",
    "keepTunnel",
    "publicUrl",
    "holdToken",
    "insecureUpstream"
  ];
  keep.forEach((key) => {
    if (rawArgv[key] !== undefined && rawArgv[key] !== true) {
      const value = key === "config" ? path.resolve(String(rawArgv[key])) : String(rawArgv[key]);
      passArgs.push(`--${key}`, value);
    } else if (rawArgv[key] === true && key === "insecureUpstream") {
      passArgs.push(`--${key}`, "true");
    }
  });
  if (options.holdToken && !rawArgv.holdToken) passArgs.push("--holdToken", String(options.holdToken));
  if (options.insecureUpstream && rawArgv.insecureUpstream === undefined) passArgs.push("--insecureUpstream", "true");
  spawnServeDetached(passArgs);

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const state = readState(options.outputDir);
    if (state && state.publicUrl && state.proxyPort && (await isServeHealthy(state.proxyPort))) {
      const publicOk = await waitUntilPublicHealthy(state.publicUrl, 45000);
      console.log(publicOk ? "HANDS_FREE_TUNNEL_READY" : "HANDS_FREE_TUNNEL_NOT_READY");
      if (!publicOk) {
        await sleep(2000);
        continue;
      }
      console.log(`HANDS_FREE_URL=${state.publicUrl}`);
      console.log(`PHONE_REVIEW_URL=${state.publicUrl}`);
      if (state.holdToken) {
        console.log(`HANDS_FREE_HOLD_TOKEN=${state.holdToken}`);
        console.log(`HANDS_FREE_OPEN=${withHoldQuery(state.publicUrl, options.openPath || "/", state.holdToken)}`);
      }
      return state;
    }
    await sleep(2000);
  }
  throw new Error("hands-free serve did not become ready (docker tunnel or proxy failed).");
}

async function waitForHold(options) {
  setHoldWait(options.runDir, true);
  setStatus(options.runDir, "listening");
  const hubHealth = await checkHubHealth(options.hub || { enabled: false, ok: false });
  const deadline = Date.now() + options.holdTimeoutMs;
  if (hubHealth.ok) {
    const queued = readUnconsumedHold(options.runDir);
    if (!queued) {
      await publishLive(hubHealth, {
        name: "live.state",
        payload: livePayload(options.runDir, "listening", { runTag: options.runTag, bump: false, swapOverlay: true })
      });
      await publishTask(hubHealth, {
        title: "Waiting for review",
        content: "Other-device overlay is WAIT. Navigate the page, then Accept or Submit.",
        stream: `hold until ${new Date(deadline).toISOString()}`,
        kind: "wait",
        phase: "wait",
        runTag: options.runTag
      });
    }
  } else {
    bumpVersion(options.runDir);
  }
  console.log(`WAITING_HANDS_FREE_HOLD until ${new Date(deadline).toISOString()}`);
  try {
    while (Date.now() < deadline) {
      const answer = readUnconsumedHold(options.runDir);
      if (answer) {
        const nextState = holdFollowupState(answer.decision, true);
        setStatus(options.runDir, nextState);
        consumeHold(options.runDir, answer);
        if (hubHealth.ok) {
          await publishLive(hubHealth, {
            name: "live.state",
            payload: livePayload(options.runDir, nextState, { runTag: options.runTag, bump: false })
          });
          await publishTask(hubHealth, holdIdeTask({
            decision: answer.decision,
            waiting: true,
            runTag: options.runTag
          }));
        } else {
          bumpVersion(options.runDir);
        }
        const raw = JSON.stringify(answer, null, 2);
        console.log("HANDS_FREE_HOLD_RECEIVED");
        console.log("PHONE_HOLD_RECEIVED");
        console.log(raw);
        return answer;
      }
      await sleep(4000);
    }
  } finally {
    setHoldWait(options.runDir, false);
  }
  console.log("HANDS_FREE_HOLD_TIMEOUT");
  console.log("PHONE_HOLD_TIMEOUT");
  const error = new Error("hands-free hold timed out");
  error.exitCode = 1;
  throw error;
}

async function watchHold(options) {
  const state = readState(options.outputDir);
  const runDir = (state && state.runDir) || options.runDir;
  if (!runDir) throw new Error("hands-free-watch needs a running hands-free session.");
  console.log("HANDS_FREE_WATCH_ON");
  let last = "";
  while (true) {
    const answer = readUnconsumedHold(runDir);
    const stamp = String((answer && answer.submittedAt) || "");
    if (stamp && stamp !== last) {
      last = stamp;
      console.log(`HANDS_FREE_HOLD_WAKE decision=${answer.decision || ""} submittedAt=${stamp}`);
    }
    await sleep(1000);
  }
}

async function reloadReview({ outputDir, args, state, hub }) {
  const runTag = args.runTag || (state && state.runTag);
  if (!runTag) throw new Error("hands-free-reload needs --runTag or a running hands-free session.");
  const runDir = runDirFrom(outputDir, runTag);
  const nextState = String(args.state || "listening") === "progress" ? "progress" : "listening";
  const answerText = args.answer != null ? String(args.answer) : (args.content != null ? String(args.content) : "");
  if (answerText) writeBox1Answer(runDir, answerText);
  setStatus(runDir, nextState);
  const hubHealth = await checkHubHealth(hub || resolveHubOptions({ args, config: {} }));
  const hubOn = Boolean(hubHealth && hubHealth.ok);
  const box1 = readBox1Answer(runDir);
  const payload = livePayload(runDir, nextState, { runTag, bump: !hubOn, swapOverlay: true, answer: box1 });
  console.log(`HANDS_FREE_RELOAD state=${nextState} v=${payload.v}`);
  if (!hubOn) {
    console.log("HUB_LIVE_OFF");
    return;
  }
  const sent = await publishLive(hubHealth, {
    name: "live.state",
    payload
  });
  console.log(sent ? "HUB_LIVE_SENT" : "HUB_LIVE_OFF");
  if (sent) {
    await publishTask(hubHealth, {
      title: nextState === "progress" ? "Thinking" : "Waiting for review",
      content:
        nextState === "progress"
          ? "Applying a live patch."
          : (box1 || "Other-device overlay is WAIT."),
      stream: `hands-free-reload state=${nextState}`,
      kind: nextState === "progress" ? "thinking" : "wait",
      phase: nextState === "progress" ? "work" : "wait",
      runTag
    });
    await ensureIdeWorking(hubHealth);
  }
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
  if (resolved === "hands-free-watch") {
    await watchHold(options);
    return { status: "watch" };
  }
  if (resolved === "hands-free-stop") {
    stopReview(outputDir);
    return { status: "stopped" };
  }
  if (resolved === "hands-free-reload") {
    await reloadReview({ outputDir, args, state: readState(outputDir), hub: options.hub });
    return { status: "reloaded" };
  }
  if (resolved === "hands-free" && args.serve) {
    await serveReview(options);
    await new Promise(() => {});
  }
  const state = await ensureServing(options, args);
  if (args.startOnly) {
    console.log("HANDS_FREE_WATCH node emulator.js hands-free-watch");
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
  "hands-free-watch",
  "phone-review",
  "phone-reload",
  "phone-stop"
]);

module.exports = {
  handlePhoneReviewCommand,
  PHONE_REVIEW_COMMANDS: HANDS_FREE_COMMANDS,
  HANDS_FREE_COMMANDS
};
