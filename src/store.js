import { randomUUID } from "node:crypto";
import { SyncError } from "./errors.js";

function storageError(error) {
  return new SyncError("OSS_ERROR", "OSS 操作失败，请核对北京公网端点、函数角色权限及网络；已完成分段可重试。", 502,
    typeof error?.code === "string" && /^[A-Za-z0-9]{1,60}$/.test(error.code) ? { ossCode: error.code } : {});
}

export async function createOssClient(config, context = {}, SDK) {
  const credentials = context.credentials;
  if (!credentials?.accessKeyId || !credentials?.accessKeySecret || !credentials?.securityToken) {
    throw new SyncError("FC_ROLE_REQUIRED", "请为 FC 绑定具有指定 OSS 目录权限的函数角色。", 500);
  }
  const OSS = SDK || (await import("ali-oss")).default;
  // Instantiate per invocation; never reuse expired context STS credentials.
  return new OSS({
    region: config.region, endpoint: config.endpoint, bucket: config.bucket, cname: config.cname,
    accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret,
    stsToken: credentials.securityToken, secure: true, timeout: config.requestTimeoutMs,
  });
}

export class OssStore {
  constructor(client, prefix, bucket) { this.client = client; this.prefix = prefix; this.bucket = bucket; }
  key(path) { return `${this.prefix}/${path}`; }
  async read(path) {
    let result;
    try { result = await this.client.get(this.key(path)); }
    catch (error) {
      if (error?.code === "NoSuchKey") return null;
      throw storageError(error);
    }
    try { return JSON.parse(result.content.toString("utf8")); }
    catch { throw new SyncError("OSS_INVALID_JSON", "OSS 数据损坏，已停止同步，不能按空数据覆盖。", 500); }
  }
  async write(path, value, once = false) {
    try {
      await this.client.put(this.key(path), Buffer.from(JSON.stringify(value)), {
        headers: {
          "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
          "x-oss-object-acl": "private", ...(once ? { "x-oss-forbid-overwrite": "true" } : {}),
        },
      });
    } catch (error) { throw storageError(error); }
  }

  async acquireLock(requestId, now = Date.now()) {
    // OSS ignores forbid-overwrite on version-enabled OR suspended buckets.
    // Refuse before writing anything rather than offering a non-atomic lock.
    let version;
    try { version = await this.client.getBucketVersioning(this.bucket); }
    catch (error) { throw storageError(error); }
    if (version.versionStatus) {
      throw new SyncError("OSS_VERSIONING_UNSUPPORTED", "此版本的同步锁要求从未启用版本控制的 Bucket；请选独立 Bucket，不要修改已有 Bucket 的保护设置。", 409);
    }
    const token = randomUUID();
    const value = { schemaVersion: 1, token, requestId, createdAt: new Date(now).toISOString() };
    try { await this.write("sync.lock.json", value, true); }
    catch (error) {
      // A successful PUT can lose its response. Read back before deciding whether
      // this invocation owns the lock. Never steal a lock on expiry.
      const current = await this.read("sync.lock.json");
      if (current?.token !== token) {
        if (current) throw new SyncError("SYNC_BUSY", "已有同步锁，请等待当前任务结束；异常退出后的锁需按 README 手工清理。", 409);
        throw error;
      }
    }
    return async () => {
      const current = await this.read("sync.lock.json");
      if (current?.token !== token) throw new SyncError("LOCK_LOST", "同步锁归属发生变化，请检查是否存在人工并发操作。", 409);
      try { await this.client.delete(this.key("sync.lock.json")); }
      catch (error) { throw storageError(error); }
    };
  }
}
