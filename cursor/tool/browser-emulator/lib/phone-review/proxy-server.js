const fs = require("fs");
const http = require("http");
const https = require("https");
const {
  PROXY_CAPABILITY,
  convertViteHmrPayload,
  detectOrigins,
  extraPrefix,
  isViteDevPath,
  mergeDetectedOrigins,
  rewriteHtml,
  rewriteOrigins,
  rewritePairsFrom,
  rewriteViteClient,
  rewriteVueSfcHmr,
  isVueModulePath,
  shouldRewriteContent,
  viteHotModulePath
} = require("./public-rewrite");

function loadWs() {
  try {
    return require("ws");
  } catch {
    try {
      return require("../../socket-server/node_modules/ws");
    } catch {
      return null;
    }
  }
}

function pickViteHmrProtocol(protocols) {
  const list = protocols && typeof protocols[Symbol.iterator] === "function" ? [...protocols] : [];
  if (list.includes("vite-hmr")) return "vite-hmr";
  return list[0] || false;
}

function parseOrigin(origin) {
  const url = new URL(origin);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
    host: url.host
  };
}

function hopByHop() {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
}

function pageOriginFromReq(req) {
  const host = String((req && req.headers && req.headers.host) || "").trim();
  if (!host) return "";
  const xf = String((req && req.headers && req.headers["x-forwarded-proto"]) || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const proto = xf === "https" || xf === "http" ? xf : "http";
  return `${proto}://${host}`;
}

function copyHeaders(source, extra = {}, opts = {}) {
  const skip = hopByHop();
  if (opts.websocket) {
    skip.delete("connection");
    skip.delete("upgrade");
  }
  const headers = {};
  Object.entries(source || {}).forEach(([key, value]) => {
    if (skip.has(String(key).toLowerCase())) return;
    headers[key] = value;
  });
  Object.assign(headers, extra);
  if (!opts.websocket) {
    headers["accept-encoding"] = "identity";
    delete headers["content-length"];
  }
  return headers;
}

function readLivePayload(files, getOverlayRev) {
  const version = fs.existsSync(files.version) ? fs.readFileSync(files.version, "utf8").trim() : "0";
  const raw = fs.existsSync(files.status) ? fs.readFileSync(files.status, "utf8").trim() : "listening";
  const state = raw === "progress" ? "progress" : "listening";
  let overlayRev = "";
  if (typeof getOverlayRev === "function") {
    try {
      overlayRev = String(getOverlayRev() || "");
    } catch {
      overlayRev = "";
    }
  }
  let answer = "";
  if (files && files.box1Answer && fs.existsSync(files.box1Answer)) {
    try {
      answer = fs.readFileSync(files.box1Answer, "utf8").trim();
    } catch {
      answer = "";
    }
  }
  return { v: version, state, overlayRev, answer, swapOverlay: Boolean(overlayRev) };
}

function sendJson(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx < 0) return;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    });
  return out;
}

function readQueryParam(urlPath, name) {
  try {
    return String(new URL(urlPath, "http://emu.local").searchParams.get(name) || "");
  } catch {
    return "";
  }
}

function holdTokenFromRequest(req, body = {}) {
  const header = String(req.headers["x-emu-hold-token"] || "").trim();
  if (header) return header;
  const bodyToken = String((body && body.holdToken) || "").trim();
  if (bodyToken) return bodyToken;
  const query = readQueryParam(req.url || "/", "emu_hold");
  if (query) return query;
  return String(parseCookies(req.headers.cookie).emu_hold || "").trim();
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  const list = Array.isArray(prev) ? prev.slice() : [String(prev)];
  list.push(cookie);
  res.setHeader("Set-Cookie", list);
}

function holdCookieValue(req, holdToken) {
  if (!holdToken) return "";
  const offered = readQueryParam(req.url || "/", "emu_hold");
  if (!offered || offered !== holdToken) return "";
  return `emu_hold=${encodeURIComponent(holdToken)}; Path=/; SameSite=Lax; HttpOnly`;
}

function withHoldCookie(headers, req, holdToken) {
  const cookie = holdCookieValue(req, holdToken);
  if (!cookie) return headers;
  const out = { ...(headers || {}) };
  const prev = out["set-cookie"] || out["Set-Cookie"];
  if (!prev) out["Set-Cookie"] = cookie;
  else if (Array.isArray(prev)) out["Set-Cookie"] = prev.concat(cookie);
  else out["Set-Cookie"] = [String(prev), cookie];
  return out;
}

function maybeGrantHoldCookie(req, res, holdToken) {
  const cookie = holdCookieValue(req, holdToken);
  if (!cookie) return false;
  appendSetCookie(res, cookie);
  return true;
}

function waitForLiveChange(files, since, sinceState, waitMs, req, res, getOverlayRev) {
  const started = Date.now();
  const timer = setInterval(() => {
    const payload = readLivePayload(files, getOverlayRev);
    const changed = (since && String(payload.v) !== String(since)) || (sinceState && payload.state !== sinceState);
    if (changed || Date.now() - started >= waitMs) {
      clearInterval(timer);
      if (!res.writableEnded) sendJson(res, payload);
    }
  }, 400);
  req.on("close", () => {
    clearInterval(timer);
  });
}

function pathHasPrefix(urlPath, prefix) {
  const raw = String(urlPath || "");
  return raw === prefix || raw.startsWith(`${prefix}/`) || raw.startsWith(`${prefix}?`);
}

function extraIndexFromPath(urlPath) {
  const match = String(urlPath || "").match(/^\/__emu\/x\/(\d+)/);
  if (match) return Number(match[1]);
  if (pathHasPrefix(urlPath, "/__emu/backend")) return 0;
  return -1;
}

function extraPathPrefix(urlPath) {
  const match = String(urlPath || "").match(/^\/__emu\/x\/(\d+)/);
  if (match) return extraPrefix(match[1]);
  if (pathHasPrefix(urlPath, "/__emu/backend")) return "/__emu/backend";
  return "";
}

function stripPrefix(urlPath, prefix) {
  const raw = String(urlPath || "/");
  if (!prefix) return raw;
  if (raw === prefix) return "/";
  if (raw.startsWith(`${prefix}/`) || raw.startsWith(`${prefix}?`)) {
    const next = raw.slice(prefix.length);
    return next.startsWith("/") || next.startsWith("?") ? next : `/${next}`;
  }
  return raw;
}

function rewritePairs(origins) {
  return rewritePairsFrom(origins);
}

function rewriteOutgoingHeaders(headers, pairs) {
  const out = { ...headers };
  ["location", "content-location"].forEach((name) => {
    if (out[name]) out[name] = rewriteOrigins(String(out[name]), pairs);
  });
  delete out["content-encoding"];
  delete out["content-length"];
  delete out["transfer-encoding"];
  return out;
}

function requestLib(protocol) {
  return protocol === "https:" ? https : http;
}

function createHandsFreeProxy({
  origin,
  hostHeader,
  stripScripts,
  overlayJs,
  files,
  viteOrigin,
  extraOrigins,
  extraHosts,
  saveDataUrl,
  writeTextFile,
  handleLiveUpgrade,
  liveEnabled,
  onHold,
  getOverlayJs,
  getOverlayRev,
  holdToken = "",
  insecureUpstream = false
}) {
  const detected = {
    viteOrigin: viteOrigin || "http://127.0.0.1:5173",
    extraOrigins: Array.isArray(extraOrigins) ? extraOrigins.filter(Boolean) : [],
    extraHosts: Array.isArray(extraHosts) ? extraHosts : []
  };
  const sessionHoldToken = String(holdToken || "").trim();
  const allowInsecureUpstream = Boolean(insecureUpstream);
  const seenViteModules = new Set();
  let persistSeenTimer = null;

  function persistSeenModules() {
    if (!files || !files.viteSeen || typeof writeTextFile !== "function") return;
    try {
      writeTextFile(files.viteSeen, JSON.stringify([...seenViteModules]));
    } catch {
      // optional cache
    }
  }

  function trackViteModule(urlPath) {
    const next = viteHotModulePath(urlPath);
    if (!next || seenViteModules.has(next)) return;
    seenViteModules.add(next);
    if (seenViteModules.size > 400) {
      const first = seenViteModules.values().next().value;
      seenViteModules.delete(first);
    }
    clearTimeout(persistSeenTimer);
    persistSeenTimer = setTimeout(persistSeenModules, 250);
  }

  if (files && files.viteSeen && fs.existsSync(files.viteSeen)) {
    try {
      const cached = JSON.parse(fs.readFileSync(files.viteSeen, "utf8"));
      if (Array.isArray(cached)) cached.forEach((item) => trackViteModule(item));
    } catch {
      // ignore stale cache
    }
  }

  function currentPairs(req) {
    return rewritePairsFrom({
      ...detected,
      pageOrigin: pageOriginFromReq(req)
    });
  }

  function extraDest(index) {
    const destOrigin = detected.extraOrigins[index];
    if (!destOrigin) return null;
    return {
      destOrigin,
      destHost: detected.extraHosts[index] || parseOrigin(destOrigin).host
    };
  }

  function forward({ req, res, destOrigin, destHost, pathOverride }) {
    const dest = parseOrigin(destOrigin);
    const lib = requestLib(dest.protocol);
    const headers = copyHeaders(req.headers, { host: destHost || dest.host });
    const trackPath = pathOverride || req.url || "/";
    if (destOrigin === detected.viteOrigin) trackViteModule(trackPath);
    const upstream = lib.request(
      {
        protocol: dest.protocol,
        hostname: dest.hostname,
        port: dest.port,
        path: pathOverride || req.url || "/",
        method: req.method,
        headers,
        rejectUnauthorized: !allowInsecureUpstream
      },
      (up) => {
        const contentType = String(up.headers["content-type"] || "");
        const pairs = currentPairs(req);
        const outHeaders = withHoldCookie(rewriteOutgoingHeaders(up.headers, pairs), req, sessionHoldToken);
        if (!shouldRewriteContent(contentType)) {
          res.writeHead(up.statusCode || 502, { ...up.headers, ...outHeaders });
          up.pipe(res);
          return;
        }
        const chunks = [];
        up.on("data", (chunk) => chunks.push(chunk));
        up.on("end", () => {
          let text = Buffer.concat(chunks).toString("utf8");
          if (/html/i.test(contentType)) {
            const found = detectOrigins(text, hostHeader);
            const merged = mergeDetectedOrigins(detected, found);
            detected.viteOrigin = merged.viteOrigin;
            detected.extraOrigins = merged.extraOrigins;
            text = rewriteHtml(text, {
              stripScripts,
              overlaySrc: "/__emu/hold.js",
              pairs: currentPairs(req)
            });
          } else {
            text = rewriteOrigins(text, currentPairs(req));
            if (/@vite\/client/i.test(req.url || "") || /vite\/dist\/client/i.test(req.url || "")) {
              text = rewriteViteClient(text);
            }
            if (isVueModulePath(pathOverride || req.url || "")) {
              text = rewriteVueSfcHmr(text);
            }
          }
          const buf = Buffer.from(text, "utf8");
          outHeaders["content-length"] = String(buf.length);
          res.writeHead(up.statusCode || 200, outHeaders);
          res.end(buf);
        });
      }
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("hands-free proxy failed");
    });
    req.pipe(upstream);
  }

  function proxyUpgrade(req, socket, head, destOrigin, destHost, pathOverride) {
    const dest = parseOrigin(destOrigin);
    const lib = requestLib(dest.protocol);
    const headers = copyHeaders(req.headers, { host: destHost || dest.host }, { websocket: true });
    const upstream = lib.request({
      protocol: dest.protocol,
      hostname: dest.hostname,
      port: dest.port,
      path: pathOverride || req.url || "/",
      method: "GET",
      headers,
      rejectUnauthorized: !allowInsecureUpstream
    });
    upstream.on("upgrade", (upRes, upSocket, upHead) => {
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      Object.entries(upRes.headers || {}).forEach(([key, value]) => {
        const items = Array.isArray(value) ? value : [value];
        items.forEach((item) => lines.push(`${key}: ${item}`));
      });
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  }

  function proxyViteHmrUpgrade(req, socket, head, destOrigin, destHost, pathOverride) {
    const wsMod = loadWs();
    if (!wsMod) {
      proxyUpgrade(req, socket, head, destOrigin, destHost, pathOverride);
      return;
    }
    const { WebSocket, WebSocketServer } = wsMod;
    const dest = parseOrigin(destOrigin);
    const proto = dest.protocol === "https:" ? "wss:" : "ws:";
    const upPath = pathOverride || req.url || "/";
    const upstreamUrl = `${proto}//${dest.host}${upPath.startsWith("/") ? upPath : `/${upPath}`}`;
    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: pickViteHmrProtocol
    });
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const incoming = String(req.headers["sec-websocket-protocol"] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const protocols = incoming.includes("vite-hmr") ? ["vite-hmr"] : incoming;
      const pending = [];
      let opened = false;
      const upstream = new WebSocket(upstreamUrl, protocols.length ? protocols : undefined, {
        // Do not forward Origin: Vite requires an HMR token when Origin is set.
        rejectUnauthorized: !allowInsecureUpstream,
        perMessageDeflate: false
      });
      function asText(data) {
        if (typeof data === "string") return data;
        if (Buffer.isBuffer(data)) return data.toString("utf8");
        if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
        if (ArrayBuffer.isView(data)) {
          return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
        }
        return String(data);
      }
      function sendUp(data, isBinary) {
        if (upstream.readyState === WebSocket.OPEN) {
          // Vite HMR is text JSON. Never forward Buffers as binary or the browser gets a Blob.
          if (isBinary) {
            const text = asText(data);
            if (text.startsWith("{") || text.startsWith("[")) {
              upstream.send(text);
              return;
            }
            upstream.send(data, { binary: true });
            return;
          }
          upstream.send(asText(data));
          return;
        }
        if (!opened) pending.push({ data, isBinary: Boolean(isBinary) });
      }
      function sendDown(data, isBinary) {
        if (clientWs.readyState !== WebSocket.OPEN) return;
        const text = asText(data);
        const looksJson = text.startsWith("{") || text.startsWith("[");
        // Browser Vite client does JSON.parse(event.data) and breaks on Blob.
        if (isBinary && !looksJson) {
          clientWs.send(data, { binary: true });
          return;
        }
        const converted = convertViteHmrPayload(text, seenViteModules);
        clientWs.send(converted == null ? text : converted);
      }
      upstream.on("open", () => {
        opened = true;
        pending.splice(0).forEach((item) => sendUp(item.data, item.isBinary));
      });
      upstream.on("message", (data, isBinary) => sendDown(data, Boolean(isBinary)));
      clientWs.on("message", (data, isBinary) => sendUp(data, Boolean(isBinary)));
      const closeBoth = () => {
        try {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        } catch {
          // ignore
        }
        try {
          if (upstream.readyState === WebSocket.OPEN) upstream.close();
        } catch {
          // ignore
        }
      };
      upstream.on("close", () => {
        try {
          clientWs.close();
        } catch {
          // ignore
        }
      });
      clientWs.on("close", () => {
        try {
          upstream.close();
        } catch {
          // ignore
        }
      });
      upstream.on("error", closeBoth);
      clientWs.on("error", closeBoth);
    });
  }

  const server = http.createServer((req, res) => {
    const urlPath = req.url || "/";
    maybeGrantHoldCookie(req, res, sessionHoldToken);

    if (urlPath.startsWith("/__emu/health")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          capability: PROXY_CAPABILITY,
          viteOrigin: detected.viteOrigin,
          extraOrigins: detected.extraOrigins,
          live: Boolean(liveEnabled),
          holdAuth: Boolean(sessionHoldToken)
        })
      );
      return;
    }

    if (urlPath.startsWith("/__emu/hold.js")) {
      let js = overlayJs;
      if (typeof getOverlayJs === "function") {
        try {
          js = getOverlayJs();
        } catch {
          js = overlayJs;
        }
      }
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(js);
      return;
    }

    if (urlPath.startsWith("/__emu/version")) {
      let since = "";
      let sinceState = "";
      let waitMs = 0;
      try {
        const parsed = new URL(urlPath, "http://emu.local");
        since = String(parsed.searchParams.get("since") || "");
        sinceState = String(parsed.searchParams.get("sinceState") || "");
        if (parsed.searchParams.get("wait") === "1") waitMs = 20000;
        const asked = Number(parsed.searchParams.get("waitMs") || 0);
        if (asked > 0) waitMs = Math.min(25000, asked);
      } catch {
        waitMs = 0;
      }
      const payload = readLivePayload(files, getOverlayRev);
      const unchanged = (!since || String(payload.v) === since) && (!sinceState || payload.state === sinceState);
      if (waitMs > 0 && since && unchanged) {
        waitForLiveChange(files, since, sinceState, waitMs, req, res, getOverlayRev);
        return;
      }
      sendJson(res, payload);
      return;
    }

    if (urlPath.startsWith("/__emu/hold") && req.method === "POST") {
      const chunks = [];
      let total = 0;
      const maxBody = 3 * 1024 * 1024;
      let rejected = false;
      req.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBody) {
          rejected = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (rejected) {
          if (!res.headersSent) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "payload_too_large" }));
          }
          return;
        }
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        if (sessionHoldToken) {
          const offered = holdTokenFromRequest(req, body);
          if (!offered || offered !== sessionHoldToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "hold_token_required" }));
            return;
          }
        }
        const hasScreenshot = saveDataUrl(body.screenshotDataUrl, files.screenshot);
        const hasAnnotation = saveDataUrl(body.annotationDataUrl, files.annotation);
        const payload = {
          kind: "holdForUserAnswer",
          source: "hands-free",
          decision: body.decision === "accept" ? "accept" : "feedback",
          noteText: String(body.noteText || "").slice(0, 4000),
          noteLength: String(body.noteText || "").length,
          strokesCount: Number(body.strokesCount || 0),
          submittedAt: new Date().toISOString(),
          userAgent: String(req.headers["user-agent"] || ""),
          hasScreenshot,
          hasAnnotation,
          zoneFound: true
        };
        writeTextFile(files.holdAnswer, JSON.stringify(payload, null, 2));
        const waiting = Boolean(files.waiting && fs.existsSync(files.waiting));
        const nextState = waiting && payload.decision === "accept" ? "listening" : "progress";
        writeTextFile(files.status, nextState);
        if (!liveEnabled) writeTextFile(files.version, String(Date.now()));
        if (typeof onHold === "function") {
          try {
            onHold(payload);
          } catch {
            // live publish is optional
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          decision: payload.decision,
          state: nextState,
          waiting,
          autoStart: !waiting,
          ideStarted: true
        }));
      });
      return;
    }

    if (urlPath.startsWith("/__emu/vite")) {
      forward({
        req,
        res,
        destOrigin: detected.viteOrigin,
        destHost: parseOrigin(detected.viteOrigin).host,
        pathOverride: stripPrefix(urlPath, "/__emu/vite")
      });
      return;
    }

    const extraIndex = extraIndexFromPath(urlPath);
    const extra = extraIndex >= 0 ? extraDest(extraIndex) : null;
    if (extra) {
      forward({
        req,
        res,
        destOrigin: extra.destOrigin,
        destHost: extra.destHost,
        pathOverride: stripPrefix(urlPath, extraPathPrefix(urlPath))
      });
      return;
    }

    if (isViteDevPath(urlPath, req.headers) && detected.viteOrigin) {
      forward({
        req,
        res,
        destOrigin: detected.viteOrigin,
        destHost: parseOrigin(detected.viteOrigin).host
      });
      return;
    }

    const pathOnly = String(urlPath.split("?")[0] || "/");
    if (detected.extraOrigins[0] && (pathOnly === "/api" || pathOnly.startsWith("/api/"))) {
      const extra = extraDest(0);
      if (extra) {
        forward({
          req,
          res,
          destOrigin: extra.destOrigin,
          destHost: extra.destHost,
          pathOverride: urlPath
        });
        return;
      }
    }

    forward({
      req,
      res,
      destOrigin: origin,
      destHost: hostHeader,
      pathOverride: urlPath
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const urlPath = req.url || "/";
    if (String(urlPath.split("?")[0] || "").startsWith("/__emu/live")) {
      if (typeof handleLiveUpgrade === "function") handleLiveUpgrade(req, socket, head);
      else socket.destroy();
      return;
    }
    const extraIndex = extraIndexFromPath(urlPath);
    const extra = extraIndex >= 0 ? extraDest(extraIndex) : null;
    if (extra) {
      proxyUpgrade(
        req,
        socket,
        head,
        extra.destOrigin,
        extra.destHost,
        stripPrefix(urlPath, extraPathPrefix(urlPath))
      );
      return;
    }
    if (detected.viteOrigin) {
      proxyViteHmrUpgrade(
        req,
        socket,
        head,
        detected.viteOrigin,
        parseOrigin(detected.viteOrigin).host,
        stripPrefix(urlPath, "/__emu/vite")
      );
    }
  });

  return server;
}

module.exports = {
  createHandsFreeProxy,
  PROXY_CAPABILITY
};
