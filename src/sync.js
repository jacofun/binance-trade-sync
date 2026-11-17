import { createHash, randomUUID } from "node:crypto";
import { DAY } from "./config.js";
import { BinanceClient } from "./binance.js";
import { createOssClient, OssStore } from "./store.js";
import { SyncError, safeError } from "./errors.js";

const HISTORY_DAYS = 80; // Conservative margin inside the ordinary 3-month API window.
function identifier(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new SyncError("BINANCE_INVALID_RESPONSE", "成交编号或资金流水编号无效。", 502);
}

export function normalizeRecord(row, kind, symbol, startTime, endTime) {
  if (!row || typeof row !== "object" || !Number.isSafeInteger(row.time) || row.time < startTime || row.time > endTime) {
    throw new SyncError("BINANCE_INVALID_RESPONSE", "明细时间无效或超出请求区间。", 502);
  }
  const result = { ...row };
  if (kind === "trades") {
    if (row.symbol !== symbol || !["BUY", "SELL"].includes(row.side) ||
        !["BOTH", "LONG", "SHORT"].includes(row.positionSide) ||
        ![row.price, row.qty, row.commission, row.realizedPnl].every((v) => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))) {
      throw new SyncError("BINANCE_INVALID_RESPONSE", "成交明细字段无效。", 502);
    }
    result.id = identifier(row.id);
    result.orderId = identifier(row.orderId);
  } else {
    if (typeof row.incomeType !== "string" || !/^[A-Z0-9_]{1,80}$/.test(row.incomeType) ||
        typeof row.asset !== "string" || typeof row.income !== "string" || !/^-?\d+(\.\d+)?$/.test(row.income)) {
      throw new SyncError("BINANCE_INVALID_RESPONSE", "资金流水字段无效。", 502);
    }
    result.tranId = identifier(row.tranId);
    if (row.tradeId !== undefined && row.tradeId !== "") result.tradeId = identifier(row.tradeId);
  }
  return result;
}

export const recordKey = (row, kind) => kind === "trades" ? `${row.symbol}:${row.id}` : `${row.incomeType}:${row.tranId}`;
const emptyState = (binding) => ({ schemaVersion: 1, product: "usdm", binding, cursors: { trades: {}, income: null }, updatedAt: null });
function validState(value, binding) {
  const cursor = (v) => v === null || (Number.isSafeInteger(v) && v > 0);
  return value?.schemaVersion === 1 && value.product === "usdm" && value.binding === binding &&
    value.cursors?.trades && typeof value.cursors.trades === "object" && !Array.isArray(value.cursors.trades) &&
    Object.values(value.cursors.trades).every(cursor) && cursor(value.cursors.income);
}

async function mergeBatch(store, rows, kind, symbol, binding, summary, now, checkBudget) {
  const months = new Map();
  for (const row of rows) {
    const month = new Date(row.time).toISOString().slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(row);
  }
  for (const [month, group] of months) {
    const path = kind === "trades" ? `usdm/trades/${symbol}/${month}.json` : `usdm/income/${month}.json`;
    checkBudget();
    const current = await store.read(path);
    if (current && (current.schemaVersion !== 1 || current.binding !== binding || current.kind !== kind ||
        current.product !== "usdm" || current.month !== month || current.symbol !== (symbol ?? null) || !Array.isArray(current.records))) {
      throw new SyncError("OSS_INVALID_DATA", "历史分区结构或账户绑定不一致，已停止覆盖。", 500);
    }
    const records = new Map();
    for (const row of current?.records ?? []) {
      const checked = normalizeRecord(row, kind, symbol, Date.parse(`${month}-01T00:00:00Z`), Date.parse(`${month}-01T00:00:00Z`) + 32 * DAY);
      if (new Date(checked.time).toISOString().slice(0, 7) !== month || records.has(recordKey(checked, kind))) {
        throw new SyncError("OSS_INVALID_DATA", "历史分区月份或唯一编号校验失败。", 500);
      }
      records.set(recordKey(checked, kind), checked);
    }
    let added = 0;
    for (const row of group) {
      const key = recordKey(row, kind);
      if (!records.has(key)) added += 1;
      records.set(key, row);
    }
    checkBudget();
    await store.write(path, {
      schemaVersion: 1, product: "usdm", binding, kind, symbol: symbol ?? null, month,
      updatedAt: new Date(now()).toISOString(),
      records: [...records.values()].sort((a, b) => a.time - b.time || recordKey(a, kind).localeCompare(recordKey(b, kind))),
    });
    summary.newRecords[kind] += added;
    summary.fetchedRecords[kind] += group.length;
  }
}

export async function synchronize(config, request, context = {}, deps = {}) {
  const now = deps.now || Date.now;
  const started = now();
  const checkBudget = () => {
    if (now() - started >= config.runBudgetMs - config.requestTimeoutMs - 5000) {
      throw new SyncError("RUN_BUDGET_EXCEEDED", "本次执行预算已用完，请再次发送相同请求，从已保存进度继续。", 503);
    }
  };
  const store = deps.store || new OssStore(await createOssClient(config, context), config.prefix, config.bucket);
  const client = deps.client || new BinanceClient(config, { now, checkBudget });
  const requestId = /^[A-Za-z0-9_-]{1,100}$/.test(context.requestId || "") ? context.requestId : randomUUID();
  const binding = createHash("sha256").update(`${config.baseUrl}\0${config.apiKey}`).digest("hex");
  const summary = {
    schemaVersion: 1, requestId, status: "running", mode: request.startTime === undefined ? "incremental" : "backfill",
    startedAt: new Date(started).toISOString(), symbols: config.symbols,
    fetchedRecords: { trades: 0, income: 0 }, newRecords: { trades: 0, income: 0 }, completedWindows: 0,
    // Counts describe this run, not lifetime trading statistics.
  };
  const release = await store.acquireLock(requestId, started);
  let result, failure;
  try {
    const loaded = await store.read("state.json");
    if (loaded && !validState(loaded, binding)) {
      throw new SyncError("STATE_MISMATCH", "同步状态无效或 API Key/环境已变更；请使用独立目录，密钥轮换参见 README。", 409);
    }
    const state = loaded || emptyState(binding);
    const serverTime = await client.syncTime();
    const targetEnd = request.endTime ?? serverTime - 60_000;
    if (targetEnd > serverTime - 60_000) throw new SyncError("INVALID_RANGE", "结束时间须早于币安服务器时间至少 60 秒。", 400);
    const streams = config.symbols.map((symbol) => ({ kind: "trades", symbol }));
    streams.push({ kind: "income", symbol: null });
    const ranges = streams.map((stream) => {
      const cursor = stream.kind === "trades" ? state.cursors.trades[stream.symbol] : state.cursors.income;
      if (cursor !== undefined && cursor !== null && cursor > serverTime) throw new SyncError("STATE_MISMATCH", "同步游标晚于服务器时间。", 409);
      const start = request.startTime ?? (cursor ? cursor - config.overlapMs : targetEnd - config.initialDays * DAY);
      if (start < serverTime - HISTORY_DAYS * DAY) throw new SyncError("HISTORY_GAP", "待同步区间超过 80 天保护范围，请先导出历史记录并处理缺口；不会静默跳过。", 409);
      return { ...stream, start, cursor };
    });
    summary.rangeEnd = new Date(targetEnd).toISOString();
    summary.ranges = ranges.map((s) => ({ kind: s.kind, symbol: s.symbol, startTime: s.start, endTime: targetEnd }));
    for (const stream of ranges) {
      for (let start = stream.start; start <= targetEnd;) {
        checkBudget();
        const end = Math.min(start + 7 * DAY - 1, targetEnd);
        for await (const batch of client.batches(stream.kind, stream.symbol, start, end)) {
          checkBudget();
          const rows = batch.map((row) => normalizeRecord(row, stream.kind, stream.symbol, start, end));
          await mergeBatch(store, rows, stream.kind, stream.symbol, binding, summary, now, checkBudget);
        }
        // Explicit backfills never jump the ordinary cursor over an unsynced gap.
        if (summary.mode === "incremental") {
          if (stream.kind === "trades") state.cursors.trades[stream.symbol] = Math.max(state.cursors.trades[stream.symbol] || 0, end);
          else state.cursors.income = Math.max(state.cursors.income || 0, end);
          state.updatedAt = new Date(now()).toISOString();
          checkBudget();
          await store.write("state.json", state);
        }
        summary.completedWindows += 1;
        start = end + 1;
      }
    }
    summary.status = "completed";
    summary.cursors = state.cursors;
    result = summary;
  } catch (error) {
    failure = error;
    summary.status = "failed";
    summary.error = safeError(error);
  }
  summary.finishedAt = new Date(now()).toISOString();
  summary.requestCount = client.requests;
  // All awaited work finishes before returning; no background tasks survive FC freeze.
  try { await store.write(`runs/${requestId}.json`, summary); }
  catch (error) { if (!failure) failure = error; }
  try { await release(); }
  catch (error) { if (!failure) failure = error; }
  if (failure) throw failure;
  return result;
}
