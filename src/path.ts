import { FsError } from "./response";

export function normalizePath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new FsError("INVALID_PATH", "Path is required", 400);
  let path = input.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+/g, "/");
  const parts = path.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) {
    throw new FsError("INVALID_PATH", "Path cannot contain '.' or '..'", 400);
  }
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function basename(path: string): string {
  if (path === "/") return "/";
  return path.slice(path.lastIndexOf("/") + 1);
}

export function splitParent(path: string): { parentPath: string; name: string } {
  const normalized = normalizePath(path);
  if (normalized === "/") throw new FsError("INVALID_PATH", "Root has no parent", 400);
  const index = normalized.lastIndexOf("/");
  return {
    parentPath: index === 0 ? "/" : normalized.slice(0, index),
    name: normalized.slice(index + 1),
  };
}
