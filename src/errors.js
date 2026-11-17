export class SyncError extends Error {
  constructor(code, message, status = 500, details = {}) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Never return SDK errors: they may contain Authorization, signed URLs or keys.
export function safeError(error) {
  return error instanceof SyncError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: "INTERNAL_ERROR", message: "同步失败，请按 requestId 检查存储权限、网络和配置。" };
}
