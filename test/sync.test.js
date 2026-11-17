import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadConfig, parseRequest, DAY } from "../src/config.js";
import { BinanceClient, parseBinanceJson } from "../src/binance.js";
import { OssStore, createOssClient } from "../src/store.js";
import { synchronize } from "../src/sync.js";
import { makeHandler } from "../index.js";
import { SyncError } from "../src/errors.js";

const NOW = Date.parse("2026-11-17T06:00:00Z");
const env = { BINANCE_API_KEY: "test-api-key", BINANCE_API_SECRET: "test-secret", OSS_BUCKET: "test-bucket", OSS_REGION: "oss-cn-beijing", OSS_ENDPOINT: "https://oss-cn-beijing.aliyuncs.com", SYNC_INITIAL_DAYS: "10" };
const config = () => loadConfig(env);
const fill = (id = "1", time = NOW - DAY) => ({ id, orderId: "22", symbol: "BTCUSDT", side: "SELL", positionSide: "BOTH", price: "70000.00000000", qty: "0.00100000", commission: "0.02800000", commissionAsset: "USDT", realizedPnl: "1.00000000", time });
const income = (tranId = "3", incomeType = "FUNDING_FEE", time = NOW - DAY) => ({ tranId, incomeType, asset: "USDT", income: "-0.01000000", symbol: "BTCUSDT", tradeId: "", time });

class FakeOss {
  data = new Map();
  writes = [];
  async getBucketVersioning() { return { versionStatus: undefined }; }
  async get(key) {
    if (!this.data.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
    return { content: Buffer.from(this.data.get(key)) };
  }
  async put(key, bytes, options = {}) {
    if (options.headers?.["x-oss-forbid-overwrite"] === "true" && this.data.has(key)) {
      throw Object.assign(new Error("conflict"), { code: "FileAlreadyExists" });
    }
    this.data.set(key, bytes.toString());
    this.writes.push({ key, options });
  }
  async delete(key) { this.data.delete(key); }
}
function fixture() {
  const oss = new FakeOss();
  const store = new OssStore(oss, config().prefix, config().bucket);
  return { oss, store, read: (path) => store.read(path) };
}
function fakeClient({ fills = [fill()], incomes = [income()], fail = () => {} } = {}) {
  return {
    requests: 0, calls: [], async syncTime() { this.requests++; return NOW; },
    async *batches(kind, symbol, start, end) {
      this.requests++;
      this.calls.push({ kind, symbol, start, end });
      fail({ kind, symbol, start, end });
      yield (kind === "trades" ? fills : incomes).filter((r) => r.time >= start && r.time <= end && (!symbol || r.symbol === symbol));
    },
  };
}
async function run(f, client = fakeClient(), request = { action: "sync" }, cfg = config()) {
  return synchronize(cfg, request, { requestId: `test-${Math.random().toString(16).slice(2)}` }, { store: f.store, client, now: () => NOW });
}
const response = (data, status = 200, headers = {}) => new Response(typeof data === "string" ? data : JSON.stringify(data), { status, headers });
function restClient(fetchImpl) { return new BinanceClient(config(), { fetchImpl, now: () => NOW, sleep: async () => {} }); }

test("config rejects arbitrary credential destinations, internal OSS and unsafe prefixes", () => {
  for (const delta of [{ BINANCE_BASE_URL: "https://example.com" }, { OSS_ENDPOINT: "https://oss-cn-beijing-internal.aliyuncs.com" }, { OSS_PREFIX: "../private" }, { SYNC_MAX_SECONDS: "300" }, { SYNC_HTTP_TOKEN: "short" }]) {
    assert.throws(() => loadConfig({ ...env, ...delta }), /配置无效/);
  }
  assert.equal(config().endpoint, env.OSS_ENDPOINT);
});

test("request requires explicit action, rejects unknown fields and ambiguous local times", () => {
  assert.deepEqual(parseRequest({ action: "sync" }), { action: "sync" });
  for (const value of [{}, { action: "sync", bucket: "other" }, { action: "sync", startTime: NOW }, { action: "sync", startTime: "2026-11-01", endTime: "2026-11-02" }]) {
    assert.throws(() => parseRequest(value), /请求|补录|时间/);
  }
  assert.equal(parseRequest({ action: "sync", startTime: "2026-11-01T00:00:00+08:00", endTime: "2026-11-02T00:00:00+08:00" }).startTime, Date.parse("2026-10-31T16:00:00Z"));
});

test("large Binance IDs stay exact strings and decimal fields stay unchanged", () => {
  const parsed = parseBinanceJson('[{"id":9007199254740993123,"orderId":9007199254740993124,"price":"0.00000001"}]');
  assert.equal(parsed[0].id, "9007199254740993123");
  assert.equal(parsed[0].orderId, "9007199254740993124");
  assert.equal(parsed[0].price, "0.00000001");
});

test("signed GET sends the expected HMAC and never a credential-bearing redirect", async () => {
  const c = restClient(async (url, options) => {
    const parsed = new URL(url);
    const signature = parsed.searchParams.get("signature");
    parsed.searchParams.delete("signature");
    assert.equal(signature, createHmac("sha256", env.BINANCE_API_SECRET).update(parsed.searchParams.toString()).digest("hex"));
    assert.equal(options.headers["X-MBX-APIKEY"], env.BINANCE_API_KEY);
    assert.equal(options.redirect, "error");
    return response([]);
  });
  assert.deepEqual(await c.request("/fapi/v1/userTrades", { symbol: "BTCUSDT" }), []);
});

test("1000-row responses split without losing equal timestamps", async () => {
  const rows = Array.from({ length: 1600 }, (_, i) => ({ time: i < 800 ? 10 : 11, id: i }));
  const c = restClient(async (url) => {
    const q = new URL(url).searchParams;
    return response(rows.filter((r) => r.time >= Number(q.get("startTime")) && r.time <= Number(q.get("endTime"))).slice(0, 1000));
  });
  const actual = [];
  for await (const batch of c.batches("trades", "BTCUSDT", 10, 11)) actual.push(...batch);
  assert.equal(actual.length, 1600);
  assert.equal(new Set(actual.map((r) => r.id)).size, 1600);
  assert.equal(c.requests, 3);
});

test("saturation in a single millisecond fails rather than claiming complete data", async () => {
  const c = restClient(async () => response(Array.from({ length: 1000 }, () => ({ time: 10 }))));
  await assert.rejects(async () => { for await (const _ of c.batches("income", null, 10, 10)) {} }, { code: "DENSE_TIMESTAMP" });
});

test("429/418 stop immediately, preserve Retry-After, and handle HTML error bodies", async () => {
  for (const status of [429, 418]) {
    const c = restClient(async () => response("blocked", status, { "retry-after": "60" }));
    await assert.rejects(() => c.request("/fapi/v1/income", {}), (e) => e.code === "BINANCE_RATE_LIMIT" && e.details.retryAfterSeconds === 60);
    assert.equal(c.requests, 1);
  }
  const c = restClient(async () => response("<h1>blocked</h1>", 451));
  await assert.rejects(() => c.request("/fapi/v1/income", {}), { code: "BINANCE_ACCESS_DENIED" });
});

test("timestamp error re-syncs the clock once, no infinite retries", async () => {
  const c = restClient(async (url) => url.includes("/time?") ? response({ serverTime: NOW + 100 }) : response({ code: -1021 }, 400));
  await assert.rejects(() => c.request("/fapi/v1/income", {}), { code: "BINANCE_API_ERROR" });
  assert.equal(c.requests, 3);
});

test("network errors discard URLs and secrets", async () => {
  const c = restClient(async () => { throw new Error(`https://secret?signature=oops ${env.BINANCE_API_SECRET}`); });
  await assert.rejects(() => c.request("/fapi/v1/income", {}), (e) => e.code === "BINANCE_NETWORK_ERROR" && !e.message.includes("secret"));
});

test("first sync persists fills/income separately and the second run deduplicates", async () => {
  const f = fixture();
  const first = await run(f);
  assert.deepEqual(first.newRecords, { trades: 1, income: 1 });
  const secondClient = fakeClient();
  const second = await run(f, secondClient);
  assert.deepEqual(second.newRecords, { trades: 0, income: 0 });
  assert.equal(secondClient.calls[0].start, NOW - 60000 - DAY);
  const trades = await f.read("usdm/trades/BTCUSDT/2026-11.json");
  assert.equal(trades.records.length, 1);
  assert.equal(trades.records[0].price, "70000.00000000");
  assert.equal((await f.read("usdm/income/2026-11.json")).records.length, 1);
  assert.equal((await f.read("state.json")).cursors.income, NOW - 60000);
  assert.equal(await f.read("sync.lock.json"), null);
});

test("same income tranId under different types remains two records", async () => {
  const f = fixture();
  await run(f, fakeClient({ incomes: [income("3", "COMMISSION"), income("3", "REALIZED_PNL")] }));
  assert.equal((await f.read("usdm/income/2026-11.json")).records.length, 2);
});

test("income failure preserves completed trade cursor and retry finishes without duplicate fills", async () => {
  const f = fixture();
  await assert.rejects(() => run(f, fakeClient({ fail: ({ kind }) => { if (kind === "income") throw new SyncError("TEST", "test failure"); } })), { code: "TEST" });
  const state = await f.read("state.json");
  assert.equal(state.cursors.trades.BTCUSDT, NOW - 60000);
  assert.equal(state.cursors.income, null);
  const retry = await run(f);
  assert.deepEqual(retry.newRecords, { trades: 0, income: 1 });
});

test("failed data write does not advance its window, and retry merges already written data", async () => {
  const f = fixture();
  const original = f.store.write.bind(f.store);
  let broken = true;
  f.store.write = async (path, ...rest) => {
    if (path === "state.json" && broken) { broken = false; throw new SyncError("TEST_WRITE", "state write failed"); }
    return original(path, ...rest);
  };
  // Put the fill into the first 7-day window so its write precedes this failure.
  const oldFill = fill("1", NOW - 9 * DAY);
  await assert.rejects(() => run(f, fakeClient({ fills: [oldFill] })), { code: "TEST_WRITE" });
  assert.equal(await f.read("state.json"), null);
  assert.equal((await f.read("usdm/trades/BTCUSDT/2026-11.json")).records.length, 1);
  const retry = await run(f, fakeClient({ fills: [oldFill] }));
  assert.equal(retry.newRecords.trades, 0);
});

test("backfill does not jump existing cursors across gaps", async () => {
  const f = fixture();
  await run(f);
  const before = await f.read("state.json");
  await run(f, fakeClient(), { action: "sync", startTime: NOW - 5 * DAY, endTime: NOW - 2 * DAY });
  assert.deepEqual(await f.read("state.json"), before);
});

test("new symbols get independent initial cursors", async () => {
  const f = fixture();
  await run(f);
  const client = fakeClient();
  await run(f, client, { action: "sync" }, { ...config(), symbols: ["BTCUSDT", "ETHUSDT"] });
  const eth = client.calls.find((c) => c.symbol === "ETHUSDT");
  assert.equal(eth.start, NOW - 60000 - 10 * DAY);
});

test("late records inside overlap are included on a later sync", async () => {
  const f = fixture();
  await run(f, fakeClient({ fills: [] }));
  await run(f, fakeClient({ fills: [fill("late", NOW - 3600000)].map((r) => ({ ...r, id: "45" })) }));
  assert.equal((await f.read("usdm/trades/BTCUSDT/2026-11.json")).records.length, 1);
});

test("old gaps, future requests and changed API keys fail closed", async () => {
  const f = fixture();
  await assert.rejects(() => run(f, fakeClient(), { action: "sync", startTime: NOW - 81 * DAY, endTime: NOW - DAY }), { code: "HISTORY_GAP" });
  await assert.rejects(() => run(f, fakeClient(), { action: "sync", startTime: NOW - DAY, endTime: NOW }), { code: "INVALID_RANGE" });
  await run(f);
  await assert.rejects(() => run(f, fakeClient(), { action: "sync" }, { ...config(), apiKey: "changed-key" }), { code: "STATE_MISMATCH" });
});

test("distributed lock prevents concurrent writers and never steals an old lock", async () => {
  const f = fixture();
  const release = await f.store.acquireLock("first", NOW - 100 * DAY);
  await assert.rejects(() => f.store.acquireLock("second", NOW), { code: "SYNC_BUSY" });
  await release();
  const nextRelease = await f.store.acquireLock("second", NOW);
  await nextRelease();
});

test("lost successful lock PUT response is recovered by reading its token", async () => {
  const f = fixture();
  const put = f.oss.put.bind(f.oss);
  f.oss.put = async (...args) => { await put(...args); throw new Error("response lost"); };
  const release = await f.store.acquireLock("same-owner", NOW);
  await release();
  assert.equal(await f.read("sync.lock.json"), null);
});

test("versioned and suspended buckets are rejected before any lock or data write", async () => {
  for (const versionStatus of ["Enabled", "Suspended"]) {
    const f = fixture();
    f.oss.getBucketVersioning = async () => ({ versionStatus });
    await assert.rejects(() => run(f), { code: "OSS_VERSIONING_UNSUPPORTED" });
    assert.equal(f.oss.writes.length, 0);
  }
});

test("budget exhaustion preserves a committed window and releases the lock", async () => {
  const f = fixture();
  let time = NOW;
  const original = f.store.write.bind(f.store);
  f.store.write = async (path, ...args) => {
    await original(path, ...args);
    if (path === "state.json") time = NOW + 240000;
  };
  await assert.rejects(() => synchronize(config(), { action: "sync" }, { requestId: "budget-test" }, { store: f.store, client: fakeClient(), now: () => time }), { code: "RUN_BUDGET_EXCEEDED" });
  assert.ok((await f.read("state.json")).cursors.trades.BTCUSDT);
  assert.equal(await f.read("sync.lock.json"), null);
  assert.equal((await f.read("runs/budget-test.json")).status, "failed");
});

test("only NoSuchKey is treated as missing; corrupted JSON is never overwritten", async () => {
  const f = fixture();
  f.oss.data.set(f.store.key("state.json"), "bad-json");
  await assert.rejects(() => run(f), { code: "OSS_INVALID_JSON" });
  assert.equal(f.oss.data.get(f.store.key("state.json")), "bad-json");
  f.oss.get = async () => { throw Object.assign(new Error("bad bucket"), { code: "NoSuchBucket" }); };
  await assert.rejects(() => f.store.read("state.json"), { code: "OSS_ERROR" });
});

test("FC role credentials are required and a client is constructed per invocation", async () => {
  await assert.rejects(() => createOssClient(config(), {}), { code: "FC_ROLE_REQUIRED" });
  const ctx = { credentials: { accessKeyId: "id", accessKeySecret: "secret", securityToken: "token" } };
  class SDK { constructor(options) { this.options = options; } }
  const first = await createOssClient(config(), ctx, SDK);
  assert.notEqual(first, await createOssClient(config(), ctx, SDK));
  assert.equal(first.options.stsToken, "token");
  assert.equal(first.options.endpoint, env.OSS_ENDPOINT);
});

test("HTTP requires POST and token; malformed requests never start synchronization", async () => {
  let runs = 0;
  const token = "a".repeat(64);
  const handler = makeHandler({ env: { ...env, SYNC_HTTP_TOKEN: token }, logger: { info() {}, error() {} }, run: async () => { runs++; return { requestId: "test" }; } });
  const event = (method = "POST", headers = {}) => ({ requestContext: { http: { method } }, headers, body: '{"action":"sync"}' });
  assert.equal((await handler(event("GET"))).statusCode, 405);
  assert.equal((await handler(event())).statusCode, 401);
  const good = event("POST", { "X-Sync-Token": token });
  good.isBase64Encoded = true;
  good.body = Buffer.from(good.body).toString("base64");
  assert.equal((await handler(Buffer.from(JSON.stringify(good)))).statusCode, 200);
  assert.equal(runs, 1);
  const disabled = makeHandler({ env, logger: { info() {}, error() {} } });
  assert.equal((await disabled(event())).statusCode, 403);
});

test("console events report genuine failures and redact unexpected SDK details", async () => {
  const messages = [];
  const handler = makeHandler({ env, logger: { info() {}, error(m) { messages.push(m); } }, run: async () => { throw new Error(`secret=${env.BINANCE_API_SECRET}`); } });
  await assert.rejects(() => handler(Buffer.from('{"action":"sync"}')), (e) => e.name === "INTERNAL_ERROR" && !e.message.includes(env.BINANCE_API_SECRET));
  assert.equal(messages.some((m) => m.includes(env.BINANCE_API_SECRET)), false);
});
