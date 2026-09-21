const assert = require("assert");
const { normalizeMode } = require("../lib/review-mode");

assert.strictEqual(normalizeMode("local-open"), "local-open");
assert.strictEqual(normalizeMode("local"), "local-open");
assert.strictEqual(normalizeMode("same-machine"), "local-open");
assert.strictEqual(normalizeMode("desktop"), "desktop");
assert.strictEqual(normalizeMode("hands-free"), "hands-free");
assert.strictEqual(normalizeMode("nope"), "");

console.log("REVIEW_MODE_OK");
