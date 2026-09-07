const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createHandsFreeProxy } = require("../lib/phone-review/proxy-server");
const { extraPrefix, PROXY_CAPABILITY } = require("../lib/phone-review/public-rewrite");
const { writeTextFile } = require("../lib/io");

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function originOf(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

(async () => {
  const vite = await listen((req, res) => {
    if (req.url.startsWith("/@vite/client")) {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end('const socketHost = `${"127.0.0.1" || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/"}`;\n');
      return;
    }
    if (req.url.startsWith("/src/main.js") || req.url.startsWith("/app.config.js")) {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end("export default {}\n");
      return;
    }
    res.writeHead(404);
    res.end("vite-miss");
  });

  const api = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end("window.apiReady=true;\n");
  });

  const app = await listen((req, res) => {
    if (req.url.split("?")[0] === "/app.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end("body{margin:0}");
      return;
    }
    if (req.url.split("?")[0] === "/sw.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end("self.addEventListener('install',()=>{});");
      return;
    }
    const html = [
      "<html><head>",
      `<script src="${originOf(api)}/js/routes.js"></script>`,
      `<script type="module" src="${originOf(vite)}/@vite/client"></script>`,
      `<script type="module" src="${originOf(vite)}/src/main.js"></script>`,
      "</head><body>ok</body></html>"
    ].join("");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "emu-rewrite-"));
  const files = {
    holdAnswer: path.join(runDir, "hold-answer.json"),
    version: path.join(runDir, "phone-version.txt"),
    status: path.join(runDir, "phone-status.txt"),
    screenshot: path.join(runDir, "hold-composite.jpg"),
    annotation: path.join(runDir, "hold-annotation.png")
  };
  fs.writeFileSync(files.status, "listening");
  fs.writeFileSync(files.version, "1");

  const proxy = createHandsFreeProxy({
    origin: originOf(app),
    hostHeader: "127.0.0.1",
    stripScripts: [],
    overlayJs: "console.log('overlay')",
    files,
    viteOrigin: originOf(vite),
    extraOrigins: [originOf(api)],
    extraHosts: [],
    saveDataUrl: () => false,
    writeTextFile
  });

  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  function get(pathname) {
    return new Promise((resolve, reject) => {
      http
        .get({ hostname: "127.0.0.1", port: proxy.address().port, path: pathname, timeout: 8000 }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode,
              type: String(res.headers["content-type"] || ""),
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
        })
        .on("error", reject);
    });
  }

  try {
    const health = await get("/__emu/health");
    const healthJson = JSON.parse(health.body);
    if (!healthJson.ok || healthJson.capability !== PROXY_CAPABILITY) {
      throw new Error(`health ${health.body}`);
    }
    const page = await get("/");
    if (page.status !== 200) throw new Error(`page status ${page.status}`);
    if (new RegExp(`src=["']${originOf(vite).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(page.body)) {
      throw new Error("page still has vite origin as script src");
    }
    if (new RegExp(`src=["']${originOf(api).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(page.body)) {
      throw new Error("page still has extra origin as script src");
    }
    if (!page.body.includes(`src="${extraPrefix(0)}/js/routes.js"`) && !page.body.includes(`src="${extraPrefix(0)}/js/routes.js`)) {
      if (!page.body.includes(`${extraPrefix(0)}/js/routes.js`)) throw new Error("page missing proxied extra script");
    }
    if (!page.body.includes("/@vite/client")) throw new Error("page missing vite client");
    if (!page.body.includes("/__emu/hold.js")) throw new Error("page missing overlay");
    const extra = await get(`${extraPrefix(0)}/js/routes.js`);
    if (extra.status !== 200) throw new Error(`extra status ${extra.status}`);
    const extraAlias = await get("/__emu/backend/js/routes.js");
    if (extraAlias.status !== 200) throw new Error(`backend alias ${extraAlias.status}`);
    const staleV2 = await get("/__emu/backend-v2/js/routes.js");
    if (staleV2.status === 200 && /window\.apiReady/.test(staleV2.body)) {
      throw new Error("backend-v2 must not be a special extra-origin path");
    }
    const viteClient = await get("/@vite/client");
    if (viteClient.status !== 200) throw new Error(`vite client status ${viteClient.status}`);
    if (!viteClient.body.includes("location.host")) throw new Error("vite client missing location.host patch");
    const rootJs = await get("/app.config.js");
    if (rootJs.status !== 200 || !/javascript/i.test(rootJs.type) || /<html/i.test(rootJs.body)) {
      throw new Error(`root js ${rootJs.status} ${rootJs.type}`);
    }
    const css = await get("/app.css");
    if (css.status !== 200 || !/css/i.test(css.type)) throw new Error(`css ${css.status} ${css.type}`);
    const sw = await get("/sw.js");
    if (sw.status !== 200 || /html/i.test(sw.type)) throw new Error(`sw ${sw.status} ${sw.type}`);
    const apiFallback = await get("/api/login");
    if (apiFallback.status !== 200) throw new Error(`api fallback ${apiFallback.status}`);
    const version = await get("/__emu/version");
    const versionJson = JSON.parse(version.body);
    if (!versionJson.v) throw new Error("version payload");
    const waitStarted = Date.now();
    const waited = await get("/__emu/version?wait=1&waitMs=300&since=1&sinceState=listening");
    const waitedMs = Date.now() - waitStarted;
    if (waitedMs < 200) throw new Error(`version wait returned too fast (${waitedMs}ms)`);
    JSON.parse(waited.body);
    console.log("PROXY_SMOKE_OK");
  } finally {
    proxy.close();
    app.close();
    vite.close();
    api.close();
  }
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
