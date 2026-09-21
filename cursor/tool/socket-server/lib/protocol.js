const { randomUUID } = require("crypto");

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const TYPES = new Set([
  "hello",
  "welcome",
  "join",
  "leave",
  "event",
  "action",
  "ack",
  "error",
  "ping",
  "pong",
  "presence"
]);
const ROLES = new Set(["agent", "tool", "client"]);

function randomId(prefix) {
  const id = randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return ROLES.has(role) ? role : "";
}

function normalizeType(value) {
  const type = String(value || "").trim().toLowerCase();
  return TYPES.has(type) ? type : "";
}

function makeMessage(partial) {
  const type = normalizeType(partial.type);
  if (!type) {
    throw new Error("message type is required");
  }
  const msg = {
    v: PROTOCOL_VERSION,
    id: String(partial.id || randomId("msg")),
    type,
    ts: Number(partial.ts || Date.now())
  };
  if (partial.room) msg.room = String(partial.room);
  if (partial.name) msg.name = String(partial.name);
  if (partial.replyTo) msg.replyTo = String(partial.replyTo);
  if (partial.from && isPlainObject(partial.from)) {
    msg.from = {
      role: normalizeRole(partial.from.role) || undefined,
      tool: partial.from.tool ? String(partial.from.tool) : undefined,
      name: partial.from.name ? String(partial.from.name) : undefined
    };
  }
  if (partial.payload !== undefined) {
    msg.payload = isPlainObject(partial.payload) ? partial.payload : { value: partial.payload };
  } else {
    msg.payload = {};
  }
  return msg;
}

function decodeRaw(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("message too large");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid json");
  }
  if (!isPlainObject(parsed)) throw new Error("message must be an object");
  const type = normalizeType(parsed.type);
  if (!type) throw new Error("unknown message type");
  if (parsed.v != null && Number(parsed.v) !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${parsed.v}`);
  }
  return makeMessage(parsed);
}

function encode(message) {
  return JSON.stringify(message);
}

function errorMessage(text, extra = {}) {
  return makeMessage({
    type: "error",
    name: extra.name || "error",
    replyTo: extra.replyTo,
    payload: { message: String(text || "error") }
  });
}

function isLoopbackHost(host) {
  const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1";
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  TYPES,
  ROLES,
  randomId,
  normalizeRole,
  normalizeType,
  makeMessage,
  decodeRaw,
  encode,
  errorMessage,
  isLoopbackHost
};
