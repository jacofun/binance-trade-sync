import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { authorize } from "../src/auth.js";
import { makeHandler } from "../index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "trade-sync-v1", use: "sig", alg: "RS256" };
const env = { SYNC_JWT_JWKS: JSON.stringify({ keys: [jwk] }) };
const NOW = 1800000000;
function token(delta = {}, headerDelta = {}, signingKey = privateKey) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT", kid: jwk.kid, ...headerDelta });
  const payload = encode({ iss: "https://www.yanxiao.me", aud: "binance-trade-sync", sub: "owner",
    scope: "trading:sync", iat: NOW, exp: NOW + 120, jti: "unique-id", ...delta });
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), signingKey).toString("base64url")}`;
}
const headers = value => ({ "X-JWT-Token": `Bearer ${value}` });

test("RS256 verifies the trusted key, issuer, audience, scope and short lifetime", () => {
  assert.equal(authorize(headers(token()), env, NOW).sub, "owner");
  assert.equal(authorize(headers(token()), env, NOW + 119).scope, "trading:sync");
  assert.throws(() => authorize(headers(token()), env, NOW + 120), { code: "UNAUTHORIZED" });
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  for (const value of [token({}, {}, otherKey), token({ exp: NOW }), token({ exp: NOW + 121 }),
    token({ iss: "evil" }), token({ aud: "website" }), token({ scope: "admin" }), token({ sub: "" }),
    token({ iat: NOW + 6 }), token({ nbf: NOW + 1 }), token({ exp: "1800000120" }), token({ jti: "" }),
    token({}, { alg: "none" }), token({}, { alg: "HS256" }), token({}, { kid: "other" }),
    token({}, { jku: "https://evil.test/jwks" }), token({}, { crit: ["b64"] }), "not-a-jwt", token() + "=",
  ]) assert.throws(() => authorize(headers(value), env, NOW), { code: "UNAUTHORIZED" });
  assert.throws(() => authorize({ "X-Sync-Token": "old-secret", "X-User-Role": "owner" }, env, NOW), { code: "UNAUTHORIZED" });
  assert.throws(() => authorize({ ...headers(token()), "x-jwt-token": `Bearer ${token()}` }, env, NOW), { code: "UNAUTHORIZED" });
});

test("dedicated JWT header is independent of CDN Authorization and never falls back to it", () => {
  const valid = token();
  assert.equal(authorize({ ...headers(valid), Authorization: "OSS cdn-origin-signature" }, env, NOW).sub, "owner");
  assert.equal(authorize({ "x-jwt-token": `Bearer ${valid}` }, env, NOW).sub, "owner");
  for (const input of [{ Authorization: `Bearer ${valid}` },
    { ...headers("invalid"), Authorization: `Bearer ${valid}` },
    { "X-JWT-Token": [valid, valid] }, { "X-JWT-Token": valid },
    { "X-JWT-Token": `Bearer ${valid}, Bearer ${valid}` }]) {
    assert.throws(() => authorize(input, env, NOW), { code: "UNAUTHORIZED" });
  }
});

test("missing, private, duplicate or weak verification keys fail closed", () => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" });
  for (const raw of ["", "invalid", JSON.stringify({ keys: [] }),
    JSON.stringify({ keys: [jwk, jwk] }), JSON.stringify({ keys: [{ ...jwk, d: "secret" }] }),
    JSON.stringify({ keys: [{ ...jwk, ...weak }] }),
  ]) assert.throws(() => authorize(headers(token()), { SYNC_JWT_JWKS: raw }, NOW), { code: "JWT_NOT_CONFIGURED" });
  const rotated = { ...jwk, kid: "next-key" };
  assert.equal(authorize(headers(token()), { SYNC_JWT_JWKS: JSON.stringify({ keys: [jwk, rotated] }) }, NOW).sub, "owner");
});

test("HTTP rejects unauthenticated requests before config/network; console events remain available", async () => {
  let runs = 0;
  const configured = { ...env, BINANCE_API_KEY: "test", BINANCE_API_SECRET: "test", OSS_BUCKET: "test",
    OSS_REGION: "oss-cn-beijing", OSS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com" };
  const run = async () => { runs++; return { requestId: "test" }; };
  const logger = { info() {}, error() {} };
  const handler = makeHandler({ env: configured, logger, run });
  const event = (method = "POST", auth = {}) => ({ requestContext: { http: { method } }, headers: auth, body: '{"action":"sync"}' });
  assert.equal((await handler(event("GET"))).statusCode, 405);
  assert.equal((await handler(event())).statusCode, 401);
  assert.equal(runs, 0);
  const good = event("POST", headers(token({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120 })));
  good.rawPath = "/trade/api/sync";
  good.isBase64Encoded = true;
  good.body = Buffer.from(good.body).toString("base64");
  assert.equal((await handler(Buffer.from(JSON.stringify(good)))).statusCode, 200);
  assert.equal(runs, 1);
  const consoleHandler = makeHandler({ env: { ...configured, SYNC_JWT_JWKS: "" }, logger, run });
  assert.equal((await consoleHandler(event())).statusCode, 503);
  assert.equal((await consoleHandler({ action: "sync" })).requestId, "test");
  assert.equal(runs, 2);
});

test("CORS preflight needs no JWT or configuration and cannot start sync", async () => {
  let runs = 0;
  const handler = makeHandler({ env: {}, logger: { info() {}, error() {} }, run: async () => { runs++; } });
  const event = (overrides = {}) => ({ rawPath: "/trade/api/sync", requestContext: { http: { method: "OPTIONS" } }, headers: {
    origin: "https://www.yanxiao.me", "access-control-request-method": "POST",
    "access-control-request-headers": "x-jwt-token, content-type", ...overrides,
  } });
  for (const origin of ["https://www.yanxiao.me", "https://yanxiao.me"]) {
    const result = await handler(event({ origin }));
    assert.equal(result.statusCode, 204);
    assert.equal(result.body, "");
    assert.equal(result.headers["Access-Control-Allow-Origin"], origin);
    assert.equal(result.headers["Access-Control-Allow-Methods"], "POST");
    assert.match(result.headers["Access-Control-Allow-Headers"], /X-JWT-Token/);
    assert.equal(result.headers.Vary, "Origin");
    assert.equal(result.headers["Access-Control-Allow-Credentials"], undefined);
  }
  for (const overrides of [{ origin: "https://evil.test" }, { origin: "null" }, { origin: "" },
    { "access-control-request-method": "DELETE" }, { "access-control-request-headers": "x-admin" }]) {
    assert.equal((await handler(event(overrides))).statusCode, 403);
  }
  const post = await handler({ requestContext: { http: { method: "POST" } },
    headers: { origin: "https://www.yanxiao.me" }, body: '{"action":"sync"}' });
  assert.equal(post.statusCode, 503); // Missing trusted keys still fails closed after preflight.
  assert.equal(JSON.parse(post.body).error.code, "JWT_NOT_CONFIGURED");
  assert.equal(post.headers["Access-Control-Allow-Origin"], "https://www.yanxiao.me");
  const protectedHandler = makeHandler({ env, logger: { info() {}, error() {} }, run: async () => { runs++; } });
  for (const auth of [{}, { "x-jwt-token": "Bearer diagnostic.invalid.token" }]) {
    const denied = await protectedHandler({ requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.yanxiao.me", ...auth }, body: '{"action":"sync"}' });
    assert.equal(denied.statusCode, 401);
    assert.equal(JSON.parse(denied.body).error.code, "UNAUTHORIZED");
    assert.equal(denied.headers["Access-Control-Allow-Origin"], "https://www.yanxiao.me");
  }
  assert.equal(runs, 0);
});
