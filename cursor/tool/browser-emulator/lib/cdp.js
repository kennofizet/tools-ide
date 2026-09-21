const { spawn } = require("child_process");
const path = require("path");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWindowsEdgePath() {
  return "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
}

function getWindowsChromePath() {
  return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}

async function isCdpEndpointUp(endpoint) {
  try {
    const normalized = String(endpoint || "").replace(/\/$/, "");
    const response = await fetch(`${normalized}/json/version`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function connectOverCdpWithRetry(chromium, endpoint, { attempts = 2, delayMs = 2000, timeoutMs = 25000 } = {}) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timer = null
    try {
      return await Promise.race([
        chromium.connectOverCDP(endpoint),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`connectOverCDP timed out after ${timeoutMs}ms`)), timeoutMs)
        })
      ])
    } catch (error) {
      lastError = error
      if (attempt === attempts)
        break
      await sleep(delayMs * attempt)
    } finally {
      if (timer)
        clearTimeout(timer)
    }
  }
  throw lastError
}

async function waitForCdpEndpoint(endpoint, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isCdpEndpointUp(endpoint);
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(350);
  }
  return false;
}

function resolveBrowserLaunchPath(browserPath, browserName) {
  if (browserPath) return browserPath;
  const normalized = String(browserName || "").toLowerCase();
  if (normalized === "chrome") return getWindowsChromePath();
  return getWindowsEdgePath();
}

function resolveCdpUserDataDir(userDataDir, cwd = process.cwd()) {
  if (!userDataDir) return path.resolve(cwd, "./output/live-edge-profile");
  return path.resolve(cwd, userDataDir);
}

function buildCdpLaunchArgs({ port, userDataDir, cwd }) {
  const profileDir = resolveCdpUserDataDir(userDataDir, cwd);
  return {
    profileDir,
    args: [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ]
  };
}

function launchBrowserWithCdp({
  browserPath,
  browserName,
  port,
  userDataDir,
  detached = true
}) {
  const executable = resolveBrowserLaunchPath(browserPath, browserName);
  const { profileDir, args } = buildCdpLaunchArgs({
    port,
    userDataDir,
    cwd: process.cwd()
  });
  const child = spawn(executable, args, {
    detached,
    stdio: detached ? "ignore" : "inherit",
    windowsHide: false,
    cwd: process.cwd()
  });
  child.on("error", () => {
    // spawn errors surface as a missing CDP endpoint after polling
  });
  if (detached) {
    child.unref();
  }
  return { pid: child.pid, profileDir, executable };
}

async function ensureLiveCdpEndpoint({
  endpoint,
  autoStart,
  browserPath,
  browserName,
  userDataDir,
  launchDetached = true,
  startupRetries = 2,
  retryLaunchDetached = true,
  timeoutMs
}) {
  const okNow = await isCdpEndpointUp(endpoint);
  if (okNow) {
    return { available: true, startedByTool: false };
  }
  if (!autoStart) {
    return { available: false, startedByTool: false };
  }

  const endpointUrl = new URL(endpoint);
  const port = Number(endpointUrl.port || 9223);
  const maxAttempts = Math.max(1, Number(startupRetries || 2));
  let availableAfterStart = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const detachedForAttempt = attempt === 1 ? launchDetached : retryLaunchDetached;
    launchBrowserWithCdp({
      browserPath,
      browserName,
      port,
      userDataDir,
      detached: detachedForAttempt
    });
    // Give browser process a small boot window before endpoint polling.
    // Retry #2 is useful when Edge cold-start is slow.
    // eslint-disable-next-line no-await-in-loop
    await sleep(700);
    // eslint-disable-next-line no-await-in-loop
    availableAfterStart = await waitForCdpEndpoint(endpoint, Math.max(Number(timeoutMs) || 0, 20000));
    if (availableAfterStart) break;
  }
  return {
    available: availableAfterStart,
    startedByTool: true
  };
}

async function pickPageFromBrowser(browser, { matchUrl, timeoutMs }) {
  const normalizeMaybeUrl = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    const bare = raw.replace(/^\/+/, "");
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(bare)) {
      return `http://${bare}`;
    }
    return `https://${bare}`;
  };
  const getHostname = (value) => {
    try {
      return new URL(normalizeMaybeUrl(value)).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  const isDomainMatch = (tabUrl, hintUrl) => {
    const tabHost = getHostname(tabUrl);
    const hintHost = getHostname(hintUrl);
    if (!tabHost || !hintHost) return false;
    return tabHost === hintHost || tabHost.endsWith(`.${hintHost}`) || hintHost.endsWith(`.${tabHost}`);
  };

  const collectPages = () => {
    return browser.contexts().flatMap((ctx) =>
      ctx.pages().map((pg) => ({ context: ctx, page: pg }))
    );
  };

  let allEntries = collectPages();
  if (!allEntries.length) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 2000)));
    allEntries = collectPages();
  }

  if (!allEntries.length) {
    throw new Error(
      "No pages found in attached browser. Open at least one page in Edge first."
    );
  }

  if (matchUrl) {
    const matched = allEntries.find((entry) => entry.page.url().includes(matchUrl))
      || allEntries.find((entry) => isDomainMatch(entry.page.url(), matchUrl));
    if (matched) {
      return {
        ...matched,
        matched: true,
        availableUrls: allEntries.map((entry) => entry.page.url())
      };
    }
  }

  const nonBlank = allEntries.find((entry) => !entry.page.url().startsWith("chrome://new-tab-page"));
  if (nonBlank) {
    return {
      ...nonBlank,
      matched: false,
      availableUrls: allEntries.map((entry) => entry.page.url())
    };
  }

  return {
    ...allEntries[0],
    matched: false,
    availableUrls: allEntries.map((entry) => entry.page.url())
  };
}

module.exports = {
  pickPageFromBrowser,
  ensureLiveCdpEndpoint,
  resolveCdpUserDataDir,
  buildCdpLaunchArgs,
  connectOverCdpWithRetry
};

