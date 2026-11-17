import { createHmac } from "node:crypto";
import JSONbigFactory from "json-bigint";
import { SyncError } from "./errors.js";

const JSONbig = JSONbigFactory({ storeAsString: true, strict: true });
export function parseBinanceJson(text) {
  try { return JSONbig.parse(text); }
  catch { throw new SyncError("BINANCE_INVALID_RESPONSE", "币安返回了无法解析的 JSON。", 502); }
}

export class BinanceClient {
  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), checkBudget = () => {} } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.checkBudget = checkBudget;
    this.offset = 0;
    this.lastRequestAt = null;
    this.requests = 0;
  }

  async syncTime() {
    const before = this.now();
    const result = await this.request("/fapi/v1/time", {}, false);
    if (!Number.isSafeInteger(result?.serverTime)) throw new SyncError("BINANCE_INVALID_RESPONSE", "币安服务器时间无效。", 502);
    this.offset = result.serverTime - Math.floor((before + this.now()) / 2);
    return result.serverTime;
  }

  async request(path, params, signed = true, clockRetried = false) {
    this.checkBudget();
    if (this.lastRequestAt !== null) {
      await this.sleep(Math.max(0, this.config.requestGapMs - (this.now() - this.lastRequestAt)));
    }
    this.checkBudget();
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    if (signed) {
      query.set("timestamp", String(this.now() + this.offset));
      query.set("recvWindow", String(this.config.recvWindow));
      query.set("signature", createHmac("sha256", this.config.apiSecret).update(query.toString()).digest("hex"));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    this.lastRequestAt = this.now();
    this.requests += 1;
    let response, payload;
    try {
      response = await this.fetch(`${this.config.baseUrl}${path}?${query}`, {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: signed ? { "X-MBX-APIKEY": this.config.apiKey } : {},
      });
      // Check status before parsing: regional blocks can return HTML.
      if ([418, 429].includes(response.status)) {
        const seconds = Number(response.headers.get("retry-after"));
        throw new SyncError("BINANCE_RATE_LIMIT", "币安限流或封禁，请等待后重试。", 429,
          { upstreamStatus: response.status, ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: Math.ceil(seconds) } : {}) });
      }
      if ([403, 451].includes(response.status)) throw new SyncError("BINANCE_ACCESS_DENIED", "币安拒绝访问，请核对账户适用条件、出口和 IP 白名单。", 502, { upstreamStatus: response.status });
      const text = await response.text();
      payload = parseBinanceJson(text);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError("BINANCE_NETWORK_ERROR", "币安请求超时或网络失败，可以重试同步。", 502);
    } finally { clearTimeout(timer); }

    if (payload?.code === -1021 && signed && !clockRetried) {
      await this.syncTime();
      return this.request(path, params, signed, true);
    }
    if (!response.ok || (payload?.code !== undefined && Number(payload.code) < 0)) {
      const code = Number(payload?.code);
      throw new SyncError("BINANCE_API_ERROR", "币安接口调用失败，请核对 API 读取权限、签名和请求参数。", 502,
        { upstreamStatus: response.status, ...(Number.isSafeInteger(code) ? { binanceCode: code } : {}) });
    }
    return payload;
  }

  // Split full responses by inclusive millisecond ranges. Never assume a full
  // response means the range is complete, and never drop equal-timestamp rows.
  async *batches(kind, symbol, startTime, endTime) {
    const path = kind === "trades" ? "/fapi/v1/userTrades" : "/fapi/v1/income";
    const rows = await this.request(path, { ...(symbol ? { symbol } : {}), startTime, endTime, limit: 1000 });
    if (!Array.isArray(rows) || rows.length > 1000) throw new SyncError("BINANCE_INVALID_RESPONSE", "币安明细响应结构无效。", 502);
    if (rows.some((row) => !Number.isSafeInteger(row?.time) || row.time < startTime || row.time > endTime)) {
      throw new SyncError("BINANCE_INVALID_RESPONSE", "币安响应未遵循查询时间范围。", 502);
    }
    if (rows.length === 1000) {
      if (startTime === endTime) throw new SyncError("DENSE_TIMESTAMP", "同一毫秒记录达到接口上限，无法确认完整性，进度未推进，请使用历史导出补录。", 409);
      const mid = startTime + Math.floor((endTime - startTime) / 2);
      yield* this.batches(kind, symbol, startTime, mid);
      yield* this.batches(kind, symbol, mid + 1, endTime);
    } else {
      yield rows;
    }
  }
}
