const {
  rewriteHtml,
  rewriteViteClient,
  detectOrigins,
  isViteDevPath,
  extraPrefix,
  rewritePairsFrom,
  convertViteHmrPayload,
  viteHotModulePath,
  rewriteVueSfcHmr
} = require("../lib/phone-review/public-rewrite");

const html = [
  "<html><head>",
  '<script src="https://api.example.test/js/routes.js?v=1"></script>',
  '<meta name="api-origin" content="https://api-v2.example.test">',
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/lib.js"></script>',
  '<script type="module" src="http://127.0.0.1:5173/@vite/client"></script>',
  '<script type="module" src="http://127.0.0.1:5173/src/main.js"></script>',
  "</head><body>ok</body></html>"
].join("");

const detected = detectOrigins(html, "app.example.test");
if (detected.viteOrigin !== "http://127.0.0.1:5173") throw new Error(`vite detect ${detected.viteOrigin}`);
if (!detected.extraOrigins.includes("https://api.example.test")) throw new Error(`extra detect ${JSON.stringify(detected.extraOrigins)}`);
if (!detected.extraOrigins.includes("https://api-v2.example.test")) throw new Error("second extra missing");
if (detected.extraOrigins.some((origin) => origin.includes("cloudflare"))) throw new Error("cdn should stay public");

const emptyPage = detectOrigins("<html><head></head><body>ok</body></html>", "shop.example.test");
if (emptyPage.extraOrigins.length) throw new Error("must not invent extra origins from the app hostname");
const sameHost = detectOrigins('<a href="https://shop.example.test/login">x</a>', "shop.example.test");
if (sameHost.extraOrigins.length) throw new Error("same-host URLs are not extra origins");

const pairs = rewritePairsFrom(detected);
const out = rewriteHtml(html, {
  stripScripts: [],
  overlaySrc: "/__emu/hold.js",
  pairs
});

if (/src=["']https?:\/\/127\.0\.0\.1:5173/.test(out)) throw new Error("vite src not rewritten");
if (/src=["']https:\/\/api\.example\.test/.test(out)) throw new Error("extra src not rewritten");
if (/src=["']https:\/\/api-v2\.example\.test/.test(out)) throw new Error("second extra not rewritten");
if (out.includes("https://cdnjs.cloudflare.com") === false) throw new Error("cdn rewrite should not strip public cdn");
if (!out.includes(`${extraPrefix(0)}/js/routes.js`)) throw new Error("extra prefix missing");
if (/src=["']:/.test(out)) throw new Error("loopback port stripped incorrectly");
if (!out.includes('src="/@vite/client"')) throw new Error("vite client not same-origin");
if (!out.includes("/src/main.js")) throw new Error("main module missing");
if (!out.includes("/__emu/hold.js")) throw new Error("overlay missing");
if (!out.includes("/*__emu-origin-map*/")) throw new Error("origin map missing");
if (out.indexOf("/*__emu-origin-map*/") > out.indexOf(`${extraPrefix(0)}/js/routes.js`)) {
  throw new Error("origin map must run before page scripts");
}

const {
  isHtmlDocument,
  rewriteHtml: rewriteHtmlDoc
} = require("../lib/phone-review/public-rewrite");
if (isHtmlDocument("0")) throw new Error("numeric API body is not an HTML document");
if (isHtmlDocument('{"n":0}')) throw new Error("json is not an HTML document");
if (!isHtmlDocument("<!DOCTYPE html><html><body>ok</body></html>")) throw new Error("doctype page should be a document");
const countBody = rewriteHtmlDoc("0", {
  stripScripts: [],
  overlaySrc: "/__emu/hold.js",
  pairs
});
if (countBody !== "0") throw new Error(`must not wrap notification counts ${countBody}`);
if (countBody.includes("__emu-origin-map") || countBody.includes("/__emu/hold.js")) {
  throw new Error("hold/origin-map leaked into a non-document HTML body");
}
if (!isViteDevPath("/@vite/client")) throw new Error("vite path");
if (!isViteDevPath("/app.config.js")) throw new Error("root alias js");
if (!isViteDevPath("/src/main.js")) throw new Error("src path");
if (!isViteDevPath("/resources/images/a.png")) throw new Error("vite images");
if (isViteDevPath("/login")) throw new Error("app route is not vite");
if (isViteDevPath("/js/app.js")) throw new Error("public js is not vite");
if (isViteDevPath("/build/assets/app.js")) throw new Error("build assets are not vite");
if (isViteDevPath("/app.css", { "sec-fetch-dest": "style" })) throw new Error("root css is public");
if (isViteDevPath("/sw.js", { "sec-fetch-dest": "script" })) throw new Error("service worker is public");
if (!isViteDevPath("/foo.png", { "sec-fetch-dest": "script" })) throw new Error("module image dest");

const client = [
  'const socketHost = `${"127.0.0.1" || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/"}`;',
  'const directSocketHost = "127.0.0.1:undefined/";',
  'const serverHost = "localhost:undefined/";',
  "await waitForSuccessfulPing(protocol, hostAndPath);\n        location.reload();",
  "const pageReload = debounceReload(50);",
  "else { pageReload(); }",
  "window.location.reload();"
].join("\n");
const patched = rewriteViteClient(client);
if (!patched.includes("location.host")) throw new Error(`hmr patch failed ${patched}`);
if (/await waitForSuccessfulPing\(protocol, hostAndPath\);\s*location\.reload\(\)/.test(patched)) {
  throw new Error("vite client still reloads after websocket drop");
}
if (!patched.includes("window.__emuViteLive")) throw new Error("vite live hook missing");
if (!patched.includes("else { return emuLiveFullReload(payload); }")) {
  throw new Error("vite full-reload still calls pageReload");
}
if (patched.includes("window.location.reload()")) {
  throw new Error("vite first-update still reloads");
}
if (!patched.includes("[vite] full-reload skipped (live)")) {
  throw new Error("vite full-reload fallback still dumps all modules");
}
if (patched.includes("performance.getEntriesByType")) {
  throw new Error("vite live fallback still scans all loaded resources");
}
if (patched.includes("emuLiveFullReload({ path: \"*\" })")) {
  throw new Error("vite live hook still blasts every hot module");
}

if (viteHotModulePath("/C:/example/app/resources/js/Foo.vue") !== "/resources/js/Foo.vue") {
  throw new Error("viteHotModulePath did not extract /resources from a layouts-plugin path");
}
if (viteHotModulePath("/resources/views/app.blade.php") !== "") {
  throw new Error("blade path should not be a vite hot module");
}

const converted = JSON.parse(
  convertViteHmrPayload(JSON.stringify({ type: "full-reload", path: "*" }), [
    "/resources/js/pages/Home.vue"
  ])
);
if (converted.type !== "update" || converted.updates[0].type !== "js-update") {
  throw new Error(`full-reload convert failed ${JSON.stringify(converted)}`);
}
if (converted.updates[0].path !== "/resources/js/pages/Home.vue") {
  throw new Error("full-reload convert used the wrong module path");
}
const fromBlade = JSON.parse(
  convertViteHmrPayload(
    JSON.stringify({ type: "full-reload", path: "C:/app/resources/views/application.blade.php" }),
    ["/resources/js/Foo.vue"]
  )
);
if (fromBlade.updates[0].path !== "/resources/js/Foo.vue") {
  throw new Error("blade full-reload did not fall back to seen vue modules");
}
const narrow = JSON.parse(
  convertViteHmrPayload(JSON.stringify({ type: "full-reload", path: "/resources/js/Foo.vue" }), [
    "/resources/js/Foo.vue",
    "/resources/js/Bar.vue",
    "/src/main.js"
  ])
);
if (narrow.updates.length !== 1 || narrow.updates[0].path !== "/resources/js/Foo.vue") {
  throw new Error(`specific full-reload must not fan-out ${JSON.stringify(narrow)}`);
}
const lastOnly = JSON.parse(
  convertViteHmrPayload(JSON.stringify({ type: "full-reload", path: "*" }), [
    "/resources/js/Foo.vue",
    "/resources/js/Bar.vue"
  ])
);
if (lastOnly.updates.length !== 1 || lastOnly.updates[0].path !== "/resources/js/Bar.vue") {
  throw new Error(`wildcard full-reload must patch only the last seen vue ${JSON.stringify(lastOnly)}`);
}
if (convertViteHmrPayload(JSON.stringify({ type: "update", updates: [] }), []) != null) {
  throw new Error("js-update payloads must pass through unchanged");
}

const vueHmr = [
  "export default {}",
  "export const _rerender_only = true",
  "import.meta.hot.accept(mod => {",
  "  const { default: updated, _rerender_only } = mod",
  "  if (_rerender_only) { __VUE_HMR_RUNTIME__.rerender(updated.__hmrId, updated.render) }",
  "  else { __VUE_HMR_RUNTIME__.reload(updated.__hmrId, updated) }",
  "})"
].join("\n");
const patchedVue = rewriteVueSfcHmr(vueHmr);
if (patchedVue.includes("if (_rerender_only)")) throw new Error("vue sfc still rerender-only");
if (!patchedVue.includes("if (false)")) throw new Error("vue sfc did not force reload");
if (patchedVue.includes("_rerender_only = true")) throw new Error("vue sfc still exports rerender-only true");

const fs = require("fs");
const path = require("path");
const overlaySrc = fs.readFileSync(path.join(__dirname, "../lib/phone-review/overlay-client.js"), "utf8");
if (!overlaySrc.includes("var defaultTop = 44")) throw new Error("overlay form must default below WAIT, not over mosaic");
if (overlaySrc.includes("defaultBottom")) throw new Error("overlay must not default bottom-left over mosaic hover targets");
if (!overlaySrc.includes("__emu-hold-form-v3")) throw new Error("overlay form storage must bump so dock-to-edge applies");
if (!overlaySrc.includes("emu-phone-dock")) throw new Error("overlay must keep a border dock icon after the form is thrown to an edge");
if (!overlaySrc.includes("clampToBorder")) throw new Error("dock icon must travel around the screen border");
if (overlaySrc.includes("cell.innerHTML")) throw new Error("overlay must not wipe Box 1 product HTML");
if (!overlaySrc.includes("clearProductAnswer")) throw new Error("overlay must clear leftover review copy from the product cell");
if (!overlaySrc.includes("960 / Math.max(window.innerWidth, 1)")) throw new Error("hold-composite must capture at least ~960px so frost/smoothness is readable");
if (overlaySrc.includes("480 / Math.max(window.innerWidth, 1)")) throw new Error("hold-composite must not stay capped at 480px");
if (!overlaySrc.includes('toDataURL("image/jpeg", 0.82)')) throw new Error("hold-composite jpeg quality must stay high enough to judge smoothness");

console.log("REWRITE_OK");
