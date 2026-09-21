const PROXY_CAPABILITY = "rewrite-v24";

function extraPrefix(index) {
  return `/__emu/x/${Number(index)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function isPublicCdnHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return /(^|\.)(googleapis\.com|gstatic\.com|google\.com|cloudflare\.com|jsdelivr\.net|unpkg\.com|facebook\.net|fbcdn\.net|twitter\.com|twimg\.com|youtube\.com|ytimg\.com|jquery\.com|bootstrapcdn\.com|fontawesome\.com|typekit\.net|cloudfront\.net|akamaihd\.net|akamaized\.net)$/i.test(
    host
  );
}

function looksLikeViteUrl(url) {
  const port = String(url.port || "");
  const path = String(url.pathname || "");
  if (isLoopbackHost(url.hostname) && (port === "5173" || port === "5174" || port === "24678")) return true;
  return (
    path.startsWith("/@") ||
    path.startsWith("/src/") ||
    path.startsWith("/resources/") ||
    path.startsWith("/node_modules") ||
    path.includes("/@vite")
  );
}

function originVariants(origin) {
  if (!origin) return [];
  let url;
  try {
    url = new URL(origin);
  } catch {
    return [String(origin).replace(/\/$/, "")];
  }
  const hosts = new Set([url.host]);
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port || defaultPort;
  if (port === defaultPort) hosts.add(url.hostname);
  else hosts.add(`${url.hostname}:${url.port || port}`);
  const protocols = url.protocol === "https:" ? ["https:", "http:"] : ["http:", "https:"];
  const out = new Set();
  for (const protocol of protocols) {
    for (const host of hosts) {
      out.add(`${protocol}//${host}`);
    }
  }
  if (isLoopbackHost(url.hostname) || looksLikeViteUrl(url)) {
    for (const host of hosts) {
      out.add(`ws://${host}`);
      out.add(`wss://${host}`);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function rewriteOrigins(text, pairs) {
  let out = String(text || "");
  for (const { from, to } of pairs) {
    if (!from || to == null) continue;
    originVariants(from).forEach((variant) => {
      if (!variant || variant === to) return;
      out = out.split(variant).join(to);
    });
  }
  return out;
}

function addUniqueOrigin(list, origin) {
  const normalized = String(origin || "").replace(/\/$/, "");
  if (!normalized) return;
  try {
    new URL(normalized);
  } catch {
    return;
  }
  if (!list.includes(normalized)) list.push(normalized);
}

function isSamePageHost(url, hostHeader) {
  const header = String(hostHeader || "").toLowerCase();
  if (!header) return false;
  if (url.host.toLowerCase() === header) return true;
  if (header.includes(":")) return false;
  if (url.hostname.toLowerCase() !== header) return false;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return port === "80" || port === "443";
}

function detectOrigins(html, hostHeader) {
  const extraOrigins = [];
  let viteOrigin = "";
  const text = String(html || "");
  const matches = text.match(/https?:\/\/[^\s"'<>\\)]+/gi) || [];
  matches.forEach((raw) => {
    let url;
    try {
      url = new URL(String(raw).replace(/[.,;]+$/, ""));
    } catch {
      return;
    }
    if (looksLikeViteUrl(url) && isLoopbackHost(url.hostname)) {
      if (!viteOrigin) viteOrigin = url.origin;
      return;
    }
    if (isSamePageHost(url, hostHeader)) return;
    if (isLoopbackHost(url.hostname) || isPrivateIpv4(url.hostname)) {
      addUniqueOrigin(extraOrigins, url.origin);
      return;
    }
    if (isPublicCdnHost(url.hostname)) return;
    addUniqueOrigin(extraOrigins, url.origin);
  });
  return { viteOrigin, extraOrigins };
}

function decodePath(urlPath) {
  const raw = String(urlPath || "/");
  const pathPart = raw.split("?")[0] || "/";
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function queryString(urlPath) {
  const raw = String(urlPath || "/");
  const idx = raw.indexOf("?");
  return idx >= 0 ? raw.slice(idx + 1) : "";
}

function isPublicStaticPath(pathOnly) {
  if (
    pathOnly.startsWith("/js/") ||
    pathOnly.startsWith("/css/") ||
    pathOnly.startsWith("/build/") ||
    pathOnly.startsWith("/vendor/") ||
    pathOnly.startsWith("/__emu/")
  ) {
    return true;
  }
  if (/^\/sw([.-].*)?\.m?js$/i.test(pathOnly)) return true;
  if (/^\/[^/]+\.(css|ico|webmanifest|map|html)$/i.test(pathOnly)) return true;
  if (/^\/manifest\.webmanifest$/i.test(pathOnly)) return true;
  return false;
}

function isViteDevPath(urlPath, headers = {}) {
  const pathOnly = decodePath(urlPath);
  const query = queryString(urlPath);
  if (isPublicStaticPath(pathOnly)) return false;
  if (
    pathOnly.startsWith("/@") ||
    pathOnly.startsWith("/resources/") ||
    pathOnly.startsWith("/node_modules") ||
    pathOnly.startsWith("/__vite") ||
    pathOnly.startsWith("/src/")
  ) {
    return true;
  }
  if (/(?:^|&)(?:import|vue|direct|raw|url)(?:=|&|$)/i.test(query)) return true;
  if (/^\/[^/]+\.(m?js|cjs|ts|tsx|jsx|vue)$/i.test(pathOnly)) return true;
  const dest = String(headers["sec-fetch-dest"] || "").toLowerCase();
  if (dest === "script" && /\.(png|jpe?g|gif|svg|webp|json)$/i.test(pathOnly)) return true;
  return false;
}

function shouldRewriteContent(contentType) {
  return /html|javascript|ecmascript|json|css|xml|text\/plain/i.test(String(contentType || ""));
}

function isHtmlDocument(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  return /<!doctype\s+html/i.test(s) || /<html[\s>]/i.test(s) || /<head[\s>]/i.test(s) || /<\/body>/i.test(s);
}

function rewriteViteClient(js) {
  let out = String(js || "")
    .replace(/const socketHost = `\$\{[^`]+\}`;/, "const socketHost = `${location.host}/`;")
    .replace(/const directSocketHost = ["'][^"']*["'];/, "const directSocketHost = `${location.host}/`;")
    .replace(/const serverHost = ["'][^"']*["'];/, "const serverHost = `${location.host}/`;");
  out = out.replace(
    /await waitForSuccessfulPing\(protocol, hostAndPath\);\s*location\.reload\(\);/g,
    "await waitForSuccessfulPing(protocol, hostAndPath);\n        try { socket = setupWebSocket(protocol, hostAndPath); } catch (err) {}"
  );
  out = out.replace(
    /const pageReload = debounceReload\(50\);/g,
    `const pageReload = debounceReload(50);
function emuNormVitePath(raw) {
  var p = String(raw || "").replace(/\\\\/g, "/");
  var idx = p.search(/\\/(resources|src)\\//);
  if (idx >= 0) p = p.slice(idx);
  if (p && p.charAt(0) !== "/" && p.indexOf(":") < 0) p = "/" + p;
  return p.split("?")[0];
}
function emuLiveFullReload(payload) {
  var p = emuNormVitePath(payload && payload.path);
  if (p === "*" || !/\\.(vue|[cm]?js|ts|tsx|jsx|css|scss)$/i.test(p)) {
    console.debug("[vite] full-reload skipped (live)");
    return;
  }
  console.debug("[vite] full-reload -> hmr", p);
  return handleMessage({
    type: "update",
    updates: [{
      type: /\\.(css|scss)(\\?|$)/i.test(p) ? "css-update" : "js-update",
      path: p,
      acceptedPath: p,
      timestamp: Date.now()
    }]
  });
}
try { window.__emuViteLive = function () { return; }; } catch (err) {}`
  );
  out = out.replace(/else \{\s*pageReload\(\);\s*\}/g, "else { return emuLiveFullReload(payload); }");
  out = out.replace(/window\.location\.reload\(\);/g, "/* live: skip first-update full reload */void 0;");
  return out;
}

function isVueModulePath(urlPath) {
  let pathOnly = String(urlPath || "").split("?")[0];
  try {
    pathOnly = decodeURIComponent(pathOnly);
  } catch {
    // keep raw path
  }
  return /\.vue$/i.test(pathOnly);
}

function rewriteVueSfcHmr(js) {
  let out = String(js || "");
  if (!/__VUE_HMR_RUNTIME__|_rerender_only/.test(out)) return out;
  out = out.replace(/export\s+const\s+_rerender_only\s*=\s*(?:true|!0)/g, "export const _rerender_only = false");
  out = out.replace(/\b_rerender_only\s*=\s*(?:true|!0)/g, "_rerender_only = false");
  out = out.replace(/([,{]\s*)_rerender_only\s*:\s*(?:true|!0)/g, "$1_rerender_only: false");
  out = out.replace(/if\s*\(\s*_rerender_only\s*\)/g, "if (false)");
  return out;
}

function viteHotModulePath(urlPath) {
  let pathOnly = String(urlPath || "").split("?")[0];
  try {
    pathOnly = decodeURIComponent(pathOnly);
  } catch {
    // keep raw path
  }
  pathOnly = pathOnly.replace(/\\/g, "/");
  const idx = pathOnly.search(/\/(resources|src)\//);
  if (idx >= 0) pathOnly = pathOnly.slice(idx);
  else if (!pathOnly.startsWith("/resources/") && !pathOnly.startsWith("/src/")) return "";
  if (/\/@vite\/|\/node_modules\/|\/@id\//.test(pathOnly)) return "";
  if (!/\.(vue|[cm]?js|ts|tsx|jsx|css|scss)$/i.test(pathOnly)) return "";
  return pathOnly;
}

function lastSeenHotModule(seenModules) {
  const seen = seenModules instanceof Set ? [...seenModules] : [...(seenModules || [])];
  let lastAny = "";
  let lastVue = "";
  seen.forEach((item) => {
    const next = viteHotModulePath(item);
    if (!next) return;
    lastAny = next;
    if (/\.vue$/i.test(next)) lastVue = next;
  });
  return lastVue || lastAny;
}

function convertViteHmrPayload(raw, seenModules) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!msg || msg.type !== "full-reload") return null;
  const path = viteHotModulePath(msg.path) || lastSeenHotModule(seenModules);
  if (!path) return null;
  return JSON.stringify({
    type: "update",
    updates: [
      {
        type: /\.(css|scss)$/i.test(path) ? "css-update" : "js-update",
        path,
        acceptedPath: path,
        timestamp: Date.now()
      }
    ]
  });
}

function rewritePairsFrom({ viteOrigin, extraOrigins, pageOrigin }) {
  const pairs = [];
  const base = String(pageOrigin || "").replace(/\/$/, "");
  if (viteOrigin) pairs.push({ from: viteOrigin, to: "" });
  (extraOrigins || []).forEach((origin, index) => {
    const prefix = extraPrefix(index);
    // Absolute same-origin targets so axios (baseURL + path) does not concatenate
    // `/__emu/x/1/...` onto the v1 baseURL. Relative prefixes break $api.* URLs.
    pairs.push({ from: origin, to: base ? `${base}${prefix}` : prefix });
  });
  return pairs;
}

function originMapBootScript(pairs) {
  const map = (pairs || [])
    .filter((pair) => pair && pair.from)
    .map((pair) => ({ from: pair.from, to: pair.to == null ? "" : pair.to }));
  return `<script>/*__emu-origin-map*/(function(){var map=${JSON.stringify(map)};function remap(s){s=String(s==null?"":s);for(var i=0;i<map.length;i++){var from=map[i].from,to=map[i].to;if(!from)continue;if(s===from||s.indexOf(from+"/")===0)return to+s.slice(from.length);}return s;}try{var desc=Object.getOwnPropertyDescriptor(URL.prototype,"origin");if(desc&&desc.get&&desc.configurable){Object.defineProperty(URL.prototype,"origin",{configurable:true,get:function(){var path=this.pathname||"";var m=path.match(/^(\\/__emu\\/x\\/\\d+)/);if(m&&this.hostname===location.hostname)return this.protocol+"//"+this.host+m[1];return desc.get.call(this);}});}}catch(e){}var ofetch=window.fetch;if(ofetch){window.fetch=function(input,init){if(typeof input==="string")input=remap(input);else if(typeof Request!=="undefined"&&input instanceof Request)input=new Request(remap(input.url),input);return ofetch.call(this,input,init);};}var open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){if(typeof url==="string")arguments[1]=remap(url);return open.apply(this,arguments);};})();</script>`;
}

function rewriteHtml(html, { stripScripts, overlaySrc, pairs }) {
  let out = String(html || "");
  (stripScripts || []).filter(Boolean).forEach((name) => {
    const escaped = escapeRegExp(name);
    out = out.replace(new RegExp(`<script[^>]*${escaped}[^>]*><\\/script>`, "gi"), "");
  });
  out = rewriteOrigins(out, pairs);
  if (!isHtmlDocument(out)) return out;
  if (!out.includes("/*__emu-origin-map*/")) {
    const boot = originMapBootScript(pairs);
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, match => `${match}${boot}`);
    else if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${boot}</head>`);
    else out = boot + out;
  }
  if (overlaySrc && !out.includes(overlaySrc)) {
    const tag = `<script src="${overlaySrc}"></script>`;
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${tag}</body>`);
    else out += tag;
  }
  return out;
}

function rewriteBody(contentType, urlPath, text, pairs) {
  let out = rewriteOrigins(text, pairs);
  if (/@vite\/client/i.test(String(urlPath || "")) || /vite\/dist\/client/i.test(String(urlPath || ""))) {
    out = rewriteViteClient(out);
  }
  if (isVueModulePath(urlPath)) {
    out = rewriteVueSfcHmr(out);
  }
  if (/html/i.test(String(contentType || ""))) {
    out = rewriteHtml(out, { pairs });
  }
  return out;
}

function mergeDetectedOrigins(current, found) {
  const extraOrigins = [...(current.extraOrigins || [])];
  (found.extraOrigins || []).forEach((origin) => addUniqueOrigin(extraOrigins, origin));
  return {
    viteOrigin: current.viteOrigin || found.viteOrigin || "",
    extraOrigins
  };
}

function parseOriginList(values) {
  const list = [];
  (Array.isArray(values) ? values : [values]).forEach((value) => {
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => addUniqueOrigin(list, item));
  });
  return list;
}

function openPathFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

module.exports = {
  PROXY_CAPABILITY,
  addUniqueOrigin,
  convertViteHmrPayload,
  lastSeenHotModule,
  detectOrigins,
  extraPrefix,
  isHtmlDocument,
  isViteDevPath,
  isVueModulePath,
  mergeDetectedOrigins,
  openPathFromUrl,
  originVariants,
  parseOriginList,
  rewriteBody,
  rewriteHtml,
  rewriteOrigins,
  rewritePairsFrom,
  rewriteViteClient,
  rewriteVueSfcHmr,
  shouldRewriteContent,
  viteHotModulePath
};
