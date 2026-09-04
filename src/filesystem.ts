import type { Env } from "./config";
import type { Storage } from "./storage";
import { basename, normalizePath } from "./path";
import { FsError } from "./response";
import { initDatabase, nodeMetadata, resolve, resolveParent } from "./database";

export async function init(env: Env) {
  await initDatabase(env);
  return { initialized: true, table: "fs_nodes" };
}

export async function list(env: Env, payload: any) {
  const path = normalizePath(payload.path ?? "/");
  const node = await resolve(env, path);
  if (!node) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  if (node.i2 !== 1) throw new FsError("NOT_A_DIRECTORY", `Path is not a directory: ${path}`, 400);
  const rows = await env.DB.prepare(`SELECT id,c1,c2,c3,i1,i2,d1,t1,v1,v2 FROM fs_nodes WHERE i1=? ORDER BY c1 ASC`).bind(node.id).all();
  return { path, entries: rows.results.map(row => nodeMetadata(row as any)) };
}

export async function stat(env: Env, payload: any) {
  const path = normalizePath(payload.path);
  const node = await resolve(env, path);
  if (!node) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  return nodeMetadata(node);
}

export async function mkdir(env: Env, payload: any) {
  const path = normalizePath(payload.path);
  if (path === "/") throw new FsError("ALREADY_EXISTS", "Root directory already exists", 409);
  if (await resolve(env, path)) throw new FsError("ALREADY_EXISTS", `Path already exists: ${path}`, 409);
  const { parent, parentPath, name } = await resolveParent(env, path);
  const result = await env.DB.prepare(`INSERT INTO fs_nodes(c1,c2,i1,i2,v1,v2) VALUES(?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(name, parentPath, parent.id).run();
  return { path, id: result.meta.last_row_id };
}

export async function readDescriptor(env: Env, payload: any) {
  const path = normalizePath(payload.path);
  const node = await resolve(env, path);
  if (!node) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  if (node.i2 === 1) throw new FsError("IS_A_DIRECTORY", `Path is a directory: ${path}`, 400);
  return {
    path,
    size: node.d1 ?? 0,
    content_type: node.c3 || "application/octet-stream",
    created_at: node.v1,
    modified_at: node.v2,
    metadata: parseMetadata(node.t1),
    data_interface: "raw",
  };
}

export async function readData(env: Env, storage: Storage, pathInput: string): Promise<Response> {
  const path = normalizePath(pathInput);
  const node = await resolve(env, path);
  if (!node) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  if (node.i2 === 1) throw new FsError("IS_A_DIRECTORY", `Path is a directory: ${path}`, 400);
  const response = await storage.read(path);
  if (response.status === 404) throw new FsError("NOT_FOUND", `File content not found: ${path}`, 404);
  if (!response.ok) throw new FsError("STORAGE_ERROR", `Storage read failed (${response.status})`, 502);
  const headers = new Headers();
  headers.set("Content-Type", node.c3 || response.headers.get("Content-Type") || "application/octet-stream");
  if (node.d1 != null) headers.set("Content-Length", String(node.d1));
  headers.set("Content-Disposition", `inline; filename="${basename(path).replace(/"/g, '\\"')}"`);
  return new Response(response.body, { status: 200, headers });
}

export async function write(env: Env, storage: Storage, payload: any, body: ReadableStream<Uint8Array> | null, contentType: string, contentLength?: string | null) {
  const path = normalizePath(payload.path);
  if (path === "/") throw new FsError("IS_A_DIRECTORY", "Cannot write to root", 400);
  if (!body) throw new FsError("EMPTY_BODY", "Write body is empty", 400);
  const { parent, parentPath, name } = await resolveParent(env, path);
  const existing = await resolve(env, path);
  if (existing?.i2 === 1) throw new FsError("IS_A_DIRECTORY", `Path is a directory: ${path}`, 400);

  const stored = await storage.write(path, body, contentType, contentLength);
  if (existing) {
    await env.DB.prepare(`UPDATE fs_nodes SET c3=?,d1=?,t1=?,v2=CURRENT_TIMESTAMP WHERE id=?`).bind(contentType, stored.size, JSON.stringify({ md5: stored.md5, fileId: stored.fileId }), existing.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO fs_nodes(c1,c2,c3,i1,i2,d1,t1,v1,v2) VALUES(?,?,?, ?,0,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(name, parentPath, contentType, parent.id, stored.size, JSON.stringify({ md5: stored.md5, fileId: stored.fileId })).run();
  }
  const node = await resolve(env, path);
  return { path, created: !existing, metadata: node ? nodeMetadata(node) : null };
}

export async function remove(env: Env, storage: Storage, payload: any) {
  const path = normalizePath(payload.path);
  if (path === "/") throw new FsError("INVALID_FIELD", "Root cannot be deleted", 400);
  const node = await resolve(env, path);
  const versions = await storage.listVersions(path);

  if (!node && versions.length === 0) throw new FsError("NOT_FOUND", `Path not found: ${path}`, 404);
  if (node?.i2 === 1) {
    const child = await env.DB.prepare(`SELECT id FROM fs_nodes WHERE i1=? LIMIT 1`).bind(node.id).first();
    if (child) throw new FsError("DIRECTORY_NOT_EMPTY", `Directory is not empty: ${path}`, 409);
    if (versions.length) throw new FsError("STORAGE_ERROR", `Unexpected storage objects for directory: ${path}`, 502);
    await env.DB.prepare(`DELETE FROM fs_nodes WHERE id=?`).bind(node.id).run();
    return { path, deleted: true };
  }

  for (const version of versions) await storage.deleteVersion(version);
  if (node) await env.DB.prepare(`DELETE FROM fs_nodes WHERE id=?`).bind(node.id).run();
  return { path, deleted: true, storage_versions_deleted: versions.length };
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}
