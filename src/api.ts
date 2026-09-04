import type { Env } from "./config";
import type { Storage } from "./storage";
import { apiError, apiResponse, FsError, rawError } from "./response";
import * as fs from "./filesystem";
import { normalizePath } from "./path";

export async function handleApi(request: Request, env: Env, storage: Storage): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { return apiError("unknown", "INVALID_JSON", "Malformed JSON body", 400); }

  const requestId = body?.request_id || "unknown";
  if (body?.version && body.version !== "v1") return apiError(requestId, "UNSUPPORTED_VERSION", `Unsupported API version: ${body.version}`, 400);
  if (body?.type && body.type !== "request") return apiError(requestId, "INVALID_TYPE", "Filesystem API requires type=request", 400);
  if (!body?.service) return apiError(requestId, "INVALID_FIELD", "Missing field: service", 400);
  if (!body?.action) return apiError(requestId, "INVALID_FIELD", "Missing field: action", 400);
  if (body?.payload == null || typeof body.payload !== "object") return apiError(requestId, "INVALID_FIELD", "Missing or invalid payload", 400);

  try {
    let payload: unknown;
    switch (body.action) {
      case "list": payload = await fs.list(env, body.payload); break;
      case "stat": payload = await fs.stat(env, body.payload); break;
      case "mkdir": payload = await fs.mkdir(env, body.payload); break;
      case "read": payload = await fs.readDescriptor(env, body.payload); break;
      case "write": payload = { path: normalizePath(body.payload.path), data_interface: "raw" }; break;
      case "delete": payload = await fs.remove(env, storage, body.payload); break;
      default: return apiError(requestId, "INVALID_ACTION", `Unsupported filesystem action: ${body.action}`, 400);
    }
    return apiResponse(requestId, payload);
  } catch (error: any) {
    if (error instanceof FsError) return apiError(requestId, error.code, error.message, error.status);
    console.error("Filesystem API error:", error);
    return apiError(requestId, "REQUEST_FAILED", error?.message || "Filesystem operation failed", 500);
  }
}

export async function handleRaw(request: Request, env: Env, storage: Storage): Promise<Response> {
  const action = request.headers.get("X-DA-Action");
  const fileKey = request.headers.get("X-DA-File-Key");
  if (!action) return rawError("INVALID_ACTION", "Missing X-DA-Action header", 400);

  try {
    if (action === "download") {
      if (!fileKey) throw new FsError("INVALID_FIELD", "Missing X-DA-File-Key header", 400);
      return await fs.readData(env, storage, fileKey);
    }
    if (action === "upload" || action === "write") {
      if (!fileKey) throw new FsError("INVALID_FIELD", "Missing X-DA-File-Key header", 400);
      const result = await fs.write(env, storage, { path: fileKey }, request.body, request.headers.get("Content-Type") || "application/octet-stream", request.headers.get("Content-Length"));
      return Response.json(result, { status: 200 });
    }
    return rawError("INVALID_ACTION", `Unsupported raw action: ${action}`, 400);
  } catch (error: any) {
    if (error instanceof FsError) return rawError(error.code, error.message, error.status);
    console.error("Raw filesystem error:", error);
    return rawError("REQUEST_FAILED", error?.message || "Raw operation failed", 500);
  }
}
