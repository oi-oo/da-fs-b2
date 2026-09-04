const SERVICE = "da-fs-b2";
const API_VERSION = "v1";

interface Env {
  DB: D1Database;
  DA_WRITE_TOKEN?: string;
  DA_INSTANCEID?: string;
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET_ID: string;
  B2_BUCKET_NAME: string;
}

interface FsNode {
  id: number;
  c1: string;
  c2: string;
  c3: string | null;
  i1: number | null;
  i2: number;
  d1: number | null;
  t1: string | null;
  v1: string;
  v2: string;
}

interface B2Auth {
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST" && request.method !== "GET") {
      return apiError("unknown", "METHOD_NOT_ALLOWED", "Method not allowed", 405);
    }

    const authError = authenticate(request, env);
    if (authError) return authError;

    try {
      if (request.method === "GET") {
        return new Response("DA Filesystem B2 service", { status: 200 });
      }

      const contentType = request.headers.get("Content-Type") || "";
      if (request.headers.get("X-DA-Action") || request.headers.get("X-DA-File-Key")) {
        return handleRaw(request, env, ctx);
      }

      if (!contentType.toLowerCase().includes("application/json")) {
        return apiError("unknown", "INVALID_CONTENT_TYPE", "Expected application/json", 400);
      }

      return handleApi(request, env, ctx);
    } catch (error: any) {
      console.error("Filesystem service error:", error);
      return apiError("unknown", "INTERNAL_ERROR", error?.message || "Internal error", 500);
    }
  }
};

function authenticate(request: Request, env: Env): Response | null {
  const expected = env.DA_WRITE_TOKEN;
  if (!expected) return null;

  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return apiError("unknown", "UNAUTHORIZED", "Missing Authorization header", 401);
  }

  const token = auth.slice(7);
  if (!token || token !== expected) {
    return apiError("unknown", "INVALID_TOKEN", "Token authentication failed", 401);
  }

  return null;
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return apiError("unknown", "INVALID_JSON", "Malformed JSON body", 400);
  }

  const requestId = body?.request_id || "unknown";
  if (body?.version && body.version !== API_VERSION) {
    return apiError(requestId, "UNSUPPORTED_VERSION", `Unsupported API version: ${body.version}`, 400);
  }
  if (body?.type && body.type !== "request") {
    return apiError(requestId, "INVALID_TYPE", "Filesystem API requires type=request", 400);
  }
  if (!body?.service) return apiError(requestId, "INVALID_FIELD", "Missing field: service", 400);
  if (!body?.action) return apiError(requestId, "INVALID_FIELD", "Missing field: action", 400);
  if (body?.payload == null || typeof body.payload !== "object") {
    return apiError(requestId, "INVALID_FIELD", "Missing or invalid payload", 400);
  }

  const action = body.action;
  const payload = body.payload;

  try {
    switch (action) {
      case "init":
        return ack(requestId, await initFilesystem(env.DB));
      case "list":
        return ack(requestId, await fsList(env.DB, payload));
      case "stat":
        return ack(requestId, await fsStat(env.DB, payload));
      case "mkdir":
        return ack(requestId, await fsMkdir(env.DB, payload));
      case "read":
        return ack(requestId, await fsReadDescriptor(env.DB, payload));
      case "write":
        return await fsWrite(requestId, request, env, ctx, payload);
      case "delete":
        return await fsDelete(requestId, env, ctx, payload);
      default:
        return apiError(requestId, "INVALID_ACTION", `Unsupported filesystem action: ${action}`, 400);
    }
  } catch (error: any) {
    if (error instanceof FsError) {
      return apiError(requestId, error.code, error.message, error.status);
    }
    console.error("Filesystem action failed:", error);
    return apiError(requestId, "REQUEST_FAILED", error?.message || "Filesystem operation failed", 500);
  }
}

async function handleRaw(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const action = request.headers.get("X-DA-Action");
  const fileKey = request.headers.get("X-DA-File-Key");

  if (!action) return rawError("INVALID_ACTION", "Missing X-DA-Action header", 400);

  try {
    switch (action) {
      case "download": {
        if (!fileKey) throw new FsError("INVALID_FIELD", "Missing X-DA-File-Key header", 400);
        const node = await resolve(env.DB, fileKey);
        if (!node) throw new FsError("NOT_FOUND", `Path not found: ${fileKey}`, 404);
        if (node.i2 === 1) throw new FsError("IS_A_DIRECTORY", `Path is a directory: ${fileKey}`, 400);

        const b2 = await getB2Auth(env, ctx);
        const response = await b2Download(b2, env.B2_BUCKET_NAME, fileKey);
        if (response.status === 404) throw new FsError("NOT_FOUND", `File content not found: ${fileKey}`, 404);
        if (!response.ok) throw new FsError("STORAGE_ERROR", `B2 download failed (${response.status})`, 502);

        const headers = new Headers();
        headers.set("Content-Type", node.c3 || response.headers.get("Content-Type") || "application/octet-stream");
        if (node.d1 != null) headers.set("Content-Length", String(node.d1));
        headers.set("Content-Disposition", `inline; filename="${basename(fileKey).replace(/"/g, "\\\"")}"`);
        headers.set("X-DA-Service", SERVICE);
        return new Response(response.body, { status: 200, headers });
      }

      default:
        return rawError("INVALID_ACTION", `Unsupported raw action: ${action}`, 400);
    }
  } catch (error: any) {
    if (error instanceof FsError) return rawError(error.code, error.message, error.status);
    console.error("Raw operation failed:", error);
    return rawError("STORAGE_ERROR", error?.message || "Storage operation failed", 500);
  }
}

async function initFilesystem(db: D1Database) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS fs_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      c1 VARCHAR(255),
      c2 VARCHAR(255),
      c3 VARCHAR(255),
      i1 INT,
      i2 INT,
      i3 INT,
      d1 DOUBLE,
      d2 DOUBLE,
      d3 DOUBLE,
      t1 TEXT,
      t2 TEXT,
      t3 TEXT,
      v1 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      v2 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      v3 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await db.batch([
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_nodes_parent_name ON fs_nodes(c2, c1)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_nodes_parent ON fs_nodes(i1)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_nodes_v2 ON fs_nodes(v2)`),
  ]);

  const root = await db.prepare(`SELECT id FROM fs_nodes WHERE c1 = '/' AND c2 = '' LIMIT 1`).first<{ id: number }>();
  if (!root) {
    await db.prepare(`INSERT INTO fs_nodes (c1, c2, i1, i2) VALUES ('/', '', NULL, 1)`).run();
  }

  return { initialized: true, table: "fs_nodes" };
}

async function fsList(db: D1Database, payload: any) {
  const path = normalizePath(payload.path ?? "/");
  const node = await resolve(db, path);
  if (!node) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  if (node.i2 !== 1) throw new FsError("NOT_A_DIRECTORY", `Path is not a directory: ${path}`, 400);

  const rows = await db.prepare(`
    SELECT id, c1, c2, c3, i1, i2, d1, t1, v1, v2
    FROM fs_nodes WHERE i1 = ? ORDER BY c1 ASC
  `).bind(node.id).all<FsNode>();

  return { path, entries: rows.results.map(nodeToMetadata) };
}

async function fsStat(db: D1Database, payload: any) {
  const path = normalizePath(payload.path);
  const node = await resolve(db, path);
  if (!node) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  return nodeToMetadata(node);
}

async function fsMkdir(db: D1Database, payload: any) {
  const path = normalizePath(payload.path);
  if (path === "/") throw new FsError("ALREADY_EXISTS", "Root directory already exists", 409);

  const existing = await resolve(db, path);
  if (existing) throw new FsError("ALREADY_EXISTS", `Path already exists: ${path}`, 409);

  const { parentPath, name } = splitParent(path);
  const parent = await resolve(db, parentPath);
  if (!parent) throw new FsError("NOT_FOUND", `Parent directory not found: ${parentPath}`, 404);
  if (parent.i2 !== 1) throw new FsError("NOT_A_DIRECTORY", `Parent is not a directory: ${parentPath}`, 400);

  const result = await db.prepare(`
    INSERT INTO fs_nodes (c1, c2, i1, i2, v1, v2) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(name, parentPath, parent.id).run();

  return { path, id: result.meta.last_row_id };
}

async function fsReadDescriptor(db: D1Database, payload: any) {
  const path = normalizePath(payload.path);
  const node = await resolve(db, path);
  if (!node) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  if (node.i2 === 1) throw new FsError("IS_A_DIRECTORY", `Path is a directory: ${path}`, 400);

  return {
    path,
    size: node.d1 ?? 0,
    content_type: node.c3 || "application/octet-stream",
    created_at: node.v1,
    modified_at: node.v2,
    metadata: parseT1(node.t1),
    data_interface: "raw",
  };
}

async function fsWrite(
  requestId: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  payload: any
): Promise<Response> {
  const path = normalizePath(payload.path);
  if (path === "/") throw new FsError("IS_A_DIRECTORY", "Cannot write to root", 400);

  const { parentPath, name } = splitParent(path);
  const parent = await resolve(env.DB, parentPath);
  if (!parent) throw new FsError("NOT_FOUND", `Parent directory not found: ${parentPath}`, 404);
  if (parent.i2 !== 1) throw new FsError("NOT_A_DIRECTORY", `Parent is not a directory: ${parentPath}`, 400);

  const existing = await resolve(env.DB, path);
  if (existing?.i2 === 1) throw new FsError("IS_A_DIRECTORY", `Path is a directory: ${path}`, 400);

  if (!request.body) throw new FsError("EMPTY_BODY", "Write body is empty", 400);

  const b2 = await getB2Auth(env, ctx);
  const contentType = request.headers.get("Content-Type") || "application/octet-stream";
  const contentLengthHeader = request.headers.get("Content-Length");

  const upload = await b2Upload(b2, env.B2_BUCKET_ID, path, request.body, contentType, contentLengthHeader);
  if (!upload.ok) {
    if (upload.status === 401) {
      clearAuthCache(ctx);
    }
    throw new FsError("UPLOAD_FAILED", `B2 upload failed (${upload.status})`, 502);
  }

  const result = await upload.json();
  const size = Number(result.contentLength ?? contentLengthHeader ?? 0);
  const metadata = JSON.stringify({ md5: result.contentMd5 || null, fileId: result.fileId || null });

  try {
    if (existing) {
      await env.DB.prepare(`
        UPDATE fs_nodes
        SET c3 = ?, d1 = ?, t1 = ?, v2 = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(contentType, size, metadata, existing.id).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO fs_nodes (c1, c2, c3, i1, i2, d1, t1, v1, v2)
        VALUES (?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).bind(name, parentPath, contentType, parent.id, size, metadata).run();
    }
  } catch (dbError) {
    console.error("D1 update failed after successful B2 upload:", dbError);
    // The B2 version is intentionally left recoverable; D1 remains authoritative.
    throw new FsError("DATABASE_ERROR", "File uploaded but filesystem metadata could not be updated", 500);
  }

  const node = await resolve(env.DB, path);
  return ack(requestId, {
    path,
    created: !existing,
    metadata: node ? nodeToMetadata(node) : null,
  });
}

async function fsDelete(requestId: string, env: Env, ctx: ExecutionContext, payload: any): Promise<Response> {
  const path = normalizePath(payload.path);
  if (path === "/") throw new FsError("INVALID_FIELD", "Root cannot be deleted", 400);

  const node = await resolve(env.DB, path);
  const b2 = await getB2Auth(env, ctx);
  const versions = await listAllB2Versions(b2, env.B2_BUCKET_ID, path);

  if (!node && versions.length === 0) {
    throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  }

  if (node?.i2 === 1) {
    const children = await env.DB.prepare(`SELECT id FROM fs_nodes WHERE i1 = ? LIMIT 1`).bind(node.id).all();
    if (children.results.length) throw new FsError("DIRECTORY_NOT_EMPTY", `Directory is not empty: ${path}`, 409);
    if (versions.length) throw new FsError("STORAGE_ERROR", `Unexpected B2 objects for directory: ${path}`, 502);
    await env.DB.prepare(`DELETE FROM fs_nodes WHERE id = ?`).bind(node.id).run();
    return ack(requestId, { path, deleted: true });
  }

  for (const version of versions) {
    const deleted = await deleteB2Version(b2, version.fileName, version.fileId);
    if (!deleted && ![404, 401].includes(deleted as any)) {
      throw new FsError("DELETE_FAILED", `Failed to delete B2 version ${version.fileId}`, 502);
    }
    if (deleted === 401) {
      clearAuthCache(ctx);
      throw new FsError("STORAGE_ERROR", "B2 authentication expired; retry delete", 502);
    }
  }

  if (node) {
    await env.DB.prepare(`DELETE FROM fs_nodes WHERE id = ?`).bind(node.id).run();
  }

  return ack(requestId, { path, deleted: true, b2_versions_deleted: versions.length });
}

async function resolve(db: D1Database, path: string): Promise<FsNode | null> {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return db.prepare(`SELECT id, c1, c2, c3, i1, i2, d1, t1, v1, v2 FROM fs_nodes WHERE c1='/' AND c2='' LIMIT 1`).first<FsNode>();
  }

  const { parentPath, name } = splitParent(normalized);
  return db.prepare(`
    SELECT id, c1, c2, c3, i1, i2, d1, t1, v1, v2
    FROM fs_nodes WHERE c2 = ? AND c1 = ? LIMIT 1
  `).bind(parentPath, name).first<FsNode>();
}

function resolveParent(path: string) {
  const normalized = normalizePath(path);
  return splitParent(normalized);
}

function normalizePath(input: string): string {
  if (typeof input !== "string") throw new FsError("INVALID_FIELD", "Path must be a string", 400);
  let path = input.trim();
  if (!path) throw new FsError("INVALID_FIELD", "Path cannot be empty", 400);
  if (!path.startsWith("/")) throw new FsError("INVALID_FIELD", "Path must start with /", 400);

  path = path.replace(/\\+/g, "/");
  const parts = path.split("/").filter(Boolean);
  if (parts.some(p => p === "." || p === "..")) {
    throw new FsError("INVALID_FIELD", "Path traversal is not allowed", 400);
  }
  return parts.length ? "/" + parts.join("/") : "/";
}

function splitParent(path: string): { parentPath: string; name: string } {
  const normalized = normalizePath(path);
  if (normalized === "/") throw new FsError("INVALID_FIELD", "Root has no parent", 400);
  const slash = normalized.lastIndexOf("/");
  const name = normalized.slice(slash + 1);
  const parentPath = slash === 0 ? "/" : normalized.slice(0, slash);
  return { parentPath, name };
}

function basename(path: string): string {
  return splitParent(path).name;
}

function nodeToMetadata(node: FsNode) {
  return {
    id: node.id,
    name: node.c1,
    path: node.c2 === "" ? "/" : node.c2 + (node.c2 === "/" ? "" : "/") + node.c1,
    type: node.i2 === 1 ? "directory" : "file",
    content_type: node.c3,
    size: node.i2 === 1 ? null : node.d1,
    created_at: node.v1,
    modified_at: node.v2,
    metadata: parseT1(node.t1),
  };
}

function parseT1(value: string | null): any {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

async function getB2Auth(env: Env, ctx: ExecutionContext, forceRefresh = false): Promise<B2Auth> {
  const cache = caches.default;
  const cacheKey = new Request("https://da-fs-b2.internal/auth", { method: "GET" });

  if (!forceRefresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached.json<B2Auth>();
  }

  if (!env.B2_KEY_ID || !env.B2_APPLICATION_KEY) {
    throw new Error("Missing B2 credentials");
  }

  const authHeader = "Basic " + btoa(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`);
  const response = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    headers: { Authorization: authHeader }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`B2 authorization failed (${response.status}): ${text}`);

  const data = JSON.parse(text) as B2Auth;
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=82800" }
  })));
  return data;
}

function clearAuthCache(ctx: ExecutionContext) {
  const cacheKey = new Request("https://da-fs-b2.internal/auth", { method: "GET" });
  ctx.waitUntil(caches.default.delete(cacheKey));
}

async function b2Download(auth: B2Auth, bucketName: string, fileName: string) {
  return fetch(`${auth.downloadUrl}/file/${bucketName}/${encodeURIComponent(fileName)}`, {
    headers: { Authorization: auth.authorizationToken }
  });
}

async function b2Upload(
  auth: B2Auth,
  bucketId: string,
  fileName: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
  contentLength: string | null
) {
  const uploadUrlResponse = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: "POST",
    headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId })
  });
  if (!uploadUrlResponse.ok) return uploadUrlResponse;

  const uploadData = await uploadUrlResponse.json<any>();
  const headers = new Headers({
    Authorization: uploadData.authorizationToken,
    "X-Bz-File-Name": encodeURIComponent(fileName),
    "Content-Type": contentType,
    "X-Bz-Content-Sha1": "do_not_verify"
  });
  if (contentLength) headers.set("Content-Length", contentLength);

  return fetch(uploadData.uploadUrl, { method: "POST", headers, body });
}

async function listAllB2Versions(auth: B2Auth, bucketId: string, fileName: string) {
  const versions: Array<{ fileName: string; fileId: string }> = [];
  let startFileName: string | undefined;
  let startFileId: string | undefined;

  while (true) {
    const body: any = { bucketId, prefix: fileName, maxFileCount: 1000 };
    if (startFileName) body.startFileName = startFileName;
    if (startFileId) body.startFileId = startFileId;

    const response = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_file_versions`, {
      method: "POST",
      headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new FsError("STORAGE_ERROR", `B2 version listing failed (${response.status})`, 502);
    }

    const data = await response.json<any>();
    for (const item of data.files || []) {
      if (item.fileName === fileName) versions.push({ fileName: item.fileName, fileId: item.fileId });
    }

    if (!data.nextFileName) break;
    startFileName = data.nextFileName;
    startFileId = data.nextFileId || undefined;
  }

  return versions;
}

async function deleteB2Version(auth: B2Auth, fileName: string, fileId: string): Promise<boolean | number> {
  const response = await fetch(`${auth.apiUrl}/b2api/v2/b2_delete_file_version`, {
    method: "POST",
    headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, fileId })
  });

  if (response.ok) return true;
  if (response.status === 404) return false;
  return response.status;
}

class FsError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = "FsError";
  }
}

function ack(requestId: string, payload: any): Response {
  return json({ type: "ack", request_id: requestId, source_id: `${SERVICE}/${globalThis?.location?.hostname || "instance"}`, payload });
}

function apiError(requestId: string, code: string, message: string, status = 400): Response {
  return json({ type: "nack", request_id: requestId, source_id: SERVICE, payload: { status: "error", code, message } }, status);
}

function rawError(code: string, message: string, status = 400): Response {
  return json({ status: "error", code, message }, status);
}

function json(value: any, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
