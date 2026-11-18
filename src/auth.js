import { createPublicKey, verify } from "node:crypto";
import { SyncError } from "./errors.js";

export const JWT_TOKEN_HEADER = "X-JWT-Token";

const denied = () => new SyncError("UNAUTHORIZED", "同步凭证无效或已过期，请重新点击同步。", 401);
const configurationError = () => new SyncError("JWT_NOT_CONFIGURED", "HTTP 同步尚未配置有效的 SYNC_JWT_JWKS。", 503);

function publicKeys(env) {
  try {
    const jwks = JSON.parse(env.SYNC_JWT_JWKS || "");
    if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 5) throw new Error();
    const keys = new Map();
    for (const jwk of jwks.keys) {
      if (jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(jwk.kid) || keys.has(jwk.kid) ||
        ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(name => name in jwk)) throw new Error();
      const key = createPublicKey({ key: jwk, format: "jwk" });
      if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
      keys.set(jwk.kid, key);
    }
    return keys;
  } catch {
    throw configurationError();
  }
}

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw denied();
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) throw denied();
  return bytes;
}

// Verify locally even when native FC JWT authentication is enabled. Never trust
// identity headers or let a token choose a remote key URL or signing algorithm.
export function authorize(headers, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const keys = publicKeys(env);
  try {
    const entries = Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === JWT_TOKEN_HEADER.toLowerCase());
    const auth = entries.length === 1 ? entries[0][1] : null;
    if (typeof auth !== "string" || auth.length > 8192 || !/^Bearer [^ ]+$/i.test(auth)) throw denied();
    const parts = auth.slice(7).split(".");
    if (parts.length !== 3) throw denied();
    const header = JSON.parse(decode(parts[0]).toString("utf8"));
    if (header?.alg !== "RS256" || header.typ !== "JWT" || header.crit || header.jku || header.jwk || header.x5u) throw denied();
    const key = keys.get(header.kid);
    if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, decode(parts[2]))) throw denied();
    const claims = JSON.parse(decode(parts[1]).toString("utf8"));
    if (claims?.iss !== (env.SYNC_JWT_ISSUER?.trim() || "https://www.yanxiao.me") ||
      claims.aud !== (env.SYNC_JWT_AUDIENCE?.trim() || "binance-trade-sync") ||
      claims.scope !== "trading:sync" || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128 ||
      typeof claims.jti !== "string" || !claims.jti || claims.jti.length > 128 ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.exp <= nowSeconds || claims.iat > nowSeconds + 5 || claims.exp <= claims.iat || claims.exp - claims.iat > 120 ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > nowSeconds))) throw denied();
    return claims;
  } catch {
    throw denied();
  }
}
