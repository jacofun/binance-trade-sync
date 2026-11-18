import { SyncError } from "./errors.js";

export const JWT_TOKEN_HEADER = "X-JWT-Token";
const denied = () => new SyncError("UNAUTHORIZED", "交易凭证无效或已过期，请重新操作。", 401);

// FC's shared native JWT ingress verifies signatures, issuer and audience.
// This managed-runtime handler is not an independently exposed HTTP server.
// Deployment audits every public ingress; never expose anonymous HTTP here.
export function authorize(headers, nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    const entries = Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === JWT_TOKEN_HEADER.toLowerCase());
    const auth = entries.length === 1 ? entries[0][1] : null;
    if (typeof auth !== "string" || auth.length > 8192 || !/^Bearer [^ ]+$/i.test(auth)) throw denied();
    const parts = auth.slice(7).split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw denied();
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims) ||
      typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128 ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) throw denied();
    return claims;
  } catch { throw denied(); }
}
