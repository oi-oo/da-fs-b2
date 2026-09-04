import type { Env } from "./config";
import { normalizePath, splitParent } from "./path";
import { FsError } from "./response";

export interface FsNode {
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

export async function initDatabase(env: Env): Promise<void> {
  const db = env.DB;
  await db.prepare(`CREATE TABLE IF NOT EXISTS fs_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    c1 VARCHAR(255), c2 VARCHAR(255), c3 VARCHAR(255),
    i1 INT, i2 INT, i3 INT,
    d1 DOUBLE, d2 DOUBLE, d3 DOUBLE,
    t1 TEXT, t2 TEXT, t3 TEXT,
    v1 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    v2 TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    v3 TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.batch([
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_nodes_parent_name ON fs_nodes(c2, c1)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_nodes_parent ON fs_nodes(i1)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_fs_nodes_v2 ON fs_nodes(v2)`),
  ]);
  const root = await db.prepare(`SELECT id FROM fs_nodes WHERE c1='/' AND c2='' LIMIT 1`).first<{ id: number }>();
  if (!root) await db.prepare(`INSERT INTO fs_nodes(c1,c2,i1,i2) VALUES('/','',NULL,1)`).run();
}

export async function resolve(env: Env, input: string): Promise<FsNode | null> {
  const path = normalizePath(input);
  if (path === "/") return env.DB.prepare(`SELECT id,c1,c2,c3,i1,i2,d1,t1,v1,v2 FROM fs_nodes WHERE c1='/' AND c2='' LIMIT 1`).first<FsNode>();
  const { parentPath, name } = splitParent(path);
  return env.DB.prepare(`SELECT id,c1,c2,c3,i1,i2,d1,t1,v1,v2 FROM fs_nodes WHERE c2=? AND c1=? LIMIT 1`).bind(parentPath, name).first<FsNode>();
}

export async function resolveParent(env: Env, input: string): Promise<{ parent: FsNode; parentPath: string; name: string }> {
  const path = normalizePath(input);
  const { parentPath, name } = splitParent(path);
  const parent = await resolve(env, parentPath);
  if (!parent) throw new FsError("NOT_FOUND", `Parent directory not found: ${parentPath}`, 404);
  if (parent.i2 !== 1) throw new FsError("NOT_A_DIRECTORY", `Parent is not a directory: ${parentPath}`, 400);
  return { parent, parentPath, name };
}

export function nodeMetadata(node: FsNode) {
  return {
    id: node.id,
    name: node.c1,
    path: node.c2 === "" ? "/" : `${node.c2}/${node.c1}`.replace(/^\/+/, "/"),
    type: node.i2 === 1 ? "directory" : "file",
    content_type: node.c3,
    size: node.i2 === 1 ? null : node.d1,
    created_at: node.v1,
    modified_at: node.v2,
    metadata: parseMetadata(node.t1),
  };
}

export function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}
