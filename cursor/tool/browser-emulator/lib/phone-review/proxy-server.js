const fs = require("fs");
const http = require("http");
const https = require("https");
const {
  PROXY_CAPABILITY,
  detectOrigins,
  extraPrefix,
  isViteDevPath,
  mergeDetectedOrigins,
  rewriteHtml,
  rewriteOrigins,
  rewritePairsFrom,
  rewriteViteClient,
  shouldRewriteContent
} = require("./public-rewrite");

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

function readLivePayload(files) {
  const version = fs.existsSync(files.version) ? fs.readFileSync(files.version, "utf8").trim() : "0";
  const raw = fs.existsSync(files.status) ? fs.readFileSync(files.status, "utf8").trim() : "listening";
  const state = raw === "progress" ? "progress" : "listening";
  return { v: version, state };
}

function sendJson(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function waitForLiveChange(files, since, sinceState, waitMs, req, res) {
  const started = Date.now();
  const timer = setInterval(() => {
    const payload = readLivePayload(files);
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
  writeTextFile
}) {
  const detected = {
    viteOrigin: viteOrigin || "http://127.0.0.1:5173",
    extraOrigins: Array.isArray(extraOrigins) ? extraOrigins.filter(Boolean) : [],
    extraHosts: Array.isArray(extraHosts) ? extraHosts : []
  };

  function currentPairs() {
    return rewritePairs(detected);
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
    const upstream = lib.request(
      {
        protocol: dest.protocol,
        hostname: dest.hostname,
        port: dest.port,
        path: pathOverride || req.url || "/",
        method: req.method,
        headers,
        rejectUnauthorized: false
      },
      (up) => {
        const contentType = String(up.headers["content-type"] || "");
        const pairs = currentPairs();
        const outHeaders = rewriteOutgoingHeaders(up.headers, pairs);
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
              pairs: currentPairs()
            });
          } else {
            text = rewriteOrigins(text, currentPairs());
            if (/@vite\/client/i.test(req.url || "") || /vite\/dist\/client/i.test(req.url || "")) {
              text = rewriteViteClient(text);
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
      rejectUnauthorized: false
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

  const server = http.createServer((req, res) => {
    const urlPath = req.url || "/";

    if (urlPath.startsWith("/__emu/health")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          capability: PROXY_CAPABILITY,
          viteOrigin: detected.viteOrigin,
          extraOrigins: detected.extraOrigins
        })
      );
      return;
    }

    if (urlPath.startsWith("/__emu/hold.js")) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(overlayJs);
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
      const payload = readLivePayload(files);
      const unchanged = (!since || String(payload.v) === since) && (!sinceState || payload.state === sinceState);
      if (waitMs > 0 && since && unchanged) {
        waitForLiveChange(files, since, sinceState, waitMs, req, res);
        return;
      }
      sendJson(res, payload);
      return;
    }

    if (urlPath.startsWith("/__emu/hold") && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        const hasScreenshot = saveDataUrl(body.screenshotDataUrl, files.screenshot);
        const hasAnnotation = saveDataUrl(body.annotationDataUrl, files.annotation);
        const payload = {
          kind: "holdForUserAnswer",
          source: "hands-free",
          decision: body.decision === "accept" ? "accept" : "feedback",
          noteText: String(body.noteText || ""),
          noteLength: String(body.noteText || "").length,
          strokesCount: Number(body.strokesCount || 0),
          submittedAt: new Date().toISOString(),
          userAgent: String(req.headers["user-agent"] || ""),
          hasScreenshot,
          hasAnnotation,
          zoneFound: true
        };
        writeTextFile(files.holdAnswer, JSON.stringify(payload, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, decision: payload.decision }));
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
      proxyUpgrade(req, socket, head, detected.viteOrigin, parseOrigin(detected.viteOrigin).host, stripPrefix(urlPath, "/__emu/vite"));
    }
  });

  return server;
}

module.exports = {
  createHandsFreeProxy,
  PROXY_CAPABILITY
};
