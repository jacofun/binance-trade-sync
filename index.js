import { authorize } from "./src/auth.js";
import { loadConfig, parseRequest } from "./src/config.js";
import { synchronize } from "./src/sync.js";
import { SyncError, safeError } from "./src/errors.js";

function decode(value) {
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 16384) throw new SyncError("INVALID_REQUEST", "请求体过大。", 400);
    try { return JSON.parse(value); }
    catch { throw new SyncError("INVALID_REQUEST", "请求体不是有效 JSON。", 400); }
  }
  return value;
}
export function makeHandler({ env = process.env, run = synchronize, logger = console } = {}) {
  return async function handle(event, context = {}) {
    let http = false;
    try {
      const input = decode(event);
      http = !!input?.requestContext?.http;
      let body = input;
      if (http) {
        if (input.requestContext.http.method !== "POST") throw new SyncError("METHOD_NOT_ALLOWED", "只支持 POST 请求。", 405);
        authorize(input.headers, env);
        if (typeof input.body !== "string" || input.body.length > 16384) throw new SyncError("INVALID_REQUEST", "HTTP 请求体无效或过大。", 400);
        body = decode(input.isBase64Encoded ? Buffer.from(input.body, "base64").toString("utf8") : input.body);
      }
      const config = loadConfig(env);
      const request = parseRequest(body);
      const result = await run(config, request, context);
      logger.info(JSON.stringify({ event: "sync_completed", requestId: result.requestId, newRecords: result.newRecords, completedWindows: result.completedWindows }));
      return http ? response(200, result) : result;
    } catch (error) {
      const safe = safeError(error);
      logger.error(JSON.stringify({ event: "sync_failed", requestId: context.requestId, ...safe }));
      if (http) return response(error instanceof SyncError ? error.status : 500, { requestId: context.requestId, error: safe });
      // Throw sanitized errors so console/API/async invocations are marked failed.
      const sanitized = new Error(JSON.stringify(safe));
      sanitized.name = safe.code;
      throw sanitized;
    }
  };
}
function response(statusCode, value) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, isBase64Encoded: false, body: JSON.stringify(value) };
}
export const handler = makeHandler();
