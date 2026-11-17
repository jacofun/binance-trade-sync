import { SyncError } from "./errors.js";

export const DAY = 86_400_000;
const invalid = (name) => { throw new SyncError("INVALID_CONFIG", `${name} 配置无效。`); };
const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) invalid(name);
  return value;
};
function integer(env, name, fallback, min, max) {
  if (env[name] === undefined || env[name] === "") return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(name);
  return value;
}

export function loadConfig(env = process.env) {
  const baseUrl = env.BINANCE_BASE_URL?.trim() || "https://fapi.binance.com";
  // Do not send API credentials to arbitrary URLs or switch regions on behalf of callers.
  if (!["https://fapi.binance.com", "https://demo-fapi.binance.com"].includes(baseUrl)) invalid("BINANCE_BASE_URL");
  const symbols = [...new Set((env.BINANCE_SYMBOLS || "BTCUSDT").split(",").map((s) => s.trim().toUpperCase()))];
  if (!symbols.length || symbols.length > 20 || symbols.some((s) => !/^[A-Z0-9_]{2,40}$/.test(s))) invalid("BINANCE_SYMBOLS");
  const endpoint = required(env, "OSS_ENDPOINT");
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/" || url.hostname.includes("-internal.")) invalid("OSS_ENDPOINT");
  } catch { invalid("OSS_ENDPOINT"); }
  const prefix = env.OSS_PREFIX?.trim() || "fc/binance-sync/owner";
  if (prefix.length > 200 || !prefix.split("/").every((p) => /^[A-Za-z0-9_-]+$/.test(p))) invalid("OSS_PREFIX");
  const region = required(env, "OSS_REGION");
  if (!/^oss-[a-z0-9-]+$/.test(region)) invalid("OSS_REGION");
  const bucket = required(env, "OSS_BUCKET");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) invalid("OSS_BUCKET");
  if (env.OSS_CNAME && !["true", "false"].includes(env.OSS_CNAME)) invalid("OSS_CNAME");
  const ossAccessKeyId = env.ACCESS_KEY_ID?.trim() || "";
  const ossAccessKeySecret = env.ACCESS_KEY_SECRET?.trim() || "";
  if (Boolean(ossAccessKeyId) !== Boolean(ossAccessKeySecret)) {
    throw new SyncError("INVALID_CONFIG", "ACCESS_KEY_ID 与 ACCESS_KEY_SECRET 必须同时配置或同时留空。");
  }
  const httpToken = env.SYNC_HTTP_TOKEN?.trim() || "";
  if (httpToken && (httpToken.length < 32 || httpToken.length > 256 || !/^[A-Za-z0-9_-]+$/.test(httpToken))) invalid("SYNC_HTTP_TOKEN");
  return {
    apiKey: required(env, "BINANCE_API_KEY"), apiSecret: required(env, "BINANCE_API_SECRET"),
    baseUrl, symbols, endpoint, region, bucket, prefix, ossAccessKeyId, ossAccessKeySecret,
    cname: env.OSS_CNAME === "true", httpToken,
    initialDays: integer(env, "SYNC_INITIAL_DAYS", 30, 1, 80),
    overlapMs: integer(env, "SYNC_OVERLAP_SECONDS", 86400, 60, 604800) * 1000,
    requestTimeoutMs: integer(env, "REQUEST_TIMEOUT_MS", 15000, 1000, 30000),
    runBudgetMs: integer(env, "SYNC_MAX_SECONDS", 240, 30, 240) * 1000,
    recvWindow: integer(env, "BINANCE_RECV_WINDOW", 5000, 1000, 60000),
    requestGapMs: integer(env, "BINANCE_REQUEST_GAP_MS", 250, 100, 5000),
  };
}

export function parseRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SyncError("INVALID_REQUEST", "请求必须是 JSON 对象。", 400);
  }
  if (Object.keys(input).some((key) => !["action", "startTime", "endTime"].includes(key)) ||
      input.action !== "sync" || ((input.startTime === undefined) !== (input.endTime === undefined))) {
    throw new SyncError("INVALID_REQUEST", "使用 action=sync；手工补录须同时提供 startTime 和 endTime。", 400);
  }
  if (input.startTime === undefined) return { action: "sync" };
  const parseTime = (v) => {
    if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
      const n = Date.parse(v);
      if (Number.isSafeInteger(n)) return n;
    }
    throw new SyncError("INVALID_REQUEST", "时间须为毫秒时间戳或带时区的 ISO 时间。", 400);
  };
  const startTime = parseTime(input.startTime);
  const endTime = parseTime(input.endTime);
  if (startTime > endTime || endTime - startTime > 80 * DAY) {
    throw new SyncError("INVALID_REQUEST", "补录时间须递增，跨度不得超过 80 天。", 400);
  }
  return { action: "sync", startTime, endTime };
}
