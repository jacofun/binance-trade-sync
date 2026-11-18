import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { authorize } from "../src/auth.js";
import { makeHandler } from "../index.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const NOW = 1800000000;
function token(delta = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const h = encode({ alg: "RS256", typ: "JWT", kid: "trade-sync-v1" });
  const p = encode({ iss: "https://www.yanxiao.me", aud: "binance-trade-sync", scope: "trading:sync", sub: "owner", iat: NOW, exp: NOW + 120, ...delta });
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}
const headers = value => ({ "X-JWT-Token": `Bearer ${value}` });

test("FC-verified shared ticket needs no local key, issuer or audience settings", () => {
  assert.equal(authorize(headers(token()), NOW).sub, "owner");
  assert.equal(authorize(headers(token({ aud: "shared-domain" })), NOW).sub, "owner");
  assert.throws(() => authorize(headers(token()), NOW + 120), { code: "UNAUTHORIZED" });
  for (const value of [token({ sub: "" }), token({ exp: "1800000120" }), "not-a-jwt", token() + "=", "e30.W10.signature"]) {
    assert.throws(() => authorize(headers(value), NOW), { code: "UNAUTHORIZED" });
  }
});

test("only the unique shared header is read; CDN Authorization never replaces it", () => {
  assert.equal(authorize({ ...headers(token()), Authorization: "OSS origin-signature" }, NOW).sub, "owner");
  for (const input of [{ Authorization: `Bearer ${token()}` }, { "X-JWT-Token": token() },
    { "X-JWT-Token": [token(), token()] }, { ...headers(token()), "x-jwt-token": `Bearer ${token()}` },
    { "X-JWT-Token": `Bearer ${token()}, Bearer ${token()}` }]) {
    assert.throws(() => authorize(input, NOW), { code: "UNAUTHORIZED" });
  }
});

test("HTTP fails before configuration/network without a ticket; console sync remains RAM-protected", async () => {
  let runs = 0;
  const env = { BINANCE_API_KEY: "test", BINANCE_API_SECRET: "test", OSS_BUCKET: "test", OSS_REGION: "oss-cn-beijing", OSS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com" };
  const handler = makeHandler({ env, logger: { info() {}, error() {} }, run: async () => { runs++; return { requestId: "test" }; } });
  const event = (method = "POST", auth = {}) => ({ requestContext: { http: { method } }, headers: auth, body: '{"action":"sync"}' });
  assert.equal((await handler(event("GET"))).statusCode, 405);
  assert.equal((await handler(event())).statusCode, 401);
  assert.equal(runs, 0);
  const good = event("POST", headers(token({ exp: Math.floor(Date.now() / 1000) + 120 })));
  good.rawPath = "/trade/api/sync";
  good.isBase64Encoded = true;
  good.body = Buffer.from(good.body).toString("base64");
  assert.equal((await handler(Buffer.from(JSON.stringify(good)))).statusCode, 200);
  assert.equal(runs, 1);
  assert.equal((await handler({ action: "sync" })).requestId, "test");
  assert.equal(runs, 2);
});

test("CORS preflight is independent of JWT and cannot start sync", async () => {
  let runs = 0;
  const handler = makeHandler({ env: {}, logger: { info() {}, error() {} }, run: async () => { runs++; } });
  const event = (overrides = {}) => ({ rawPath: "/trade/api/sync", requestContext: { http: { method: "OPTIONS" } }, headers: {
    origin: "https://www.yanxiao.me", "access-control-request-method": "POST", "access-control-request-headers": "x-jwt-token, content-type", ...overrides,
  } });
  for (const origin of ["https://www.yanxiao.me", "https://yanxiao.me"]) {
    const response = await handler(event({ origin }));
    assert.equal(response.statusCode, 204); assert.equal(response.body, "");
    assert.equal(response.headers["Access-Control-Allow-Origin"], origin);
    assert.match(response.headers["Access-Control-Allow-Headers"], /X-JWT-Token/);
  }
  for (const delta of [{ origin: "https://evil.test" }, { "access-control-request-method": "DELETE" }, { "access-control-request-headers": "x-admin" }]) {
    assert.equal((await handler(event(delta))).statusCode, 403);
  }
  assert.equal(runs, 0);
});
