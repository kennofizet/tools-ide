const {
  rewriteHtml,
  rewriteViteClient,
  detectOrigins,
  isViteDevPath,
  extraPrefix,
  rewritePairsFrom
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
  'const serverHost = "localhost:undefined/";'
].join("\n");
const patched = rewriteViteClient(client);
if (!patched.includes("location.host")) throw new Error(`hmr patch failed ${patched}`);

console.log("REWRITE_OK");
