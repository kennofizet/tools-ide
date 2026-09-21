const assert = require("assert");
const path = require("path");
const { resolveCdpUserDataDir, buildCdpLaunchArgs } = require("../lib/cdp");

const cwd = path.resolve(__dirname, "..");
const relative = resolveCdpUserDataDir("./output/live-edge-profile-9224", cwd);
assert.strictEqual(
  relative,
  path.resolve(cwd, "./output/live-edge-profile-9224")
);
assert.ok(path.isAbsolute(relative));

const { profileDir, args } = buildCdpLaunchArgs({
  port: 9224,
  userDataDir: "./output/live-edge-profile-9224",
  cwd
});
assert.strictEqual(profileDir, relative);
assert.ok(args.includes("--remote-debugging-port=9224"));
assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
assert.ok(args.includes("--remote-allow-origins=*"));
assert.ok(args.some((item) => item.startsWith("--user-data-dir=") && path.isAbsolute(item.slice(16))));
assert.ok(args.includes("about:blank"));

console.log("test-cdp-launch ok");
