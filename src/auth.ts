import type { Env } from "./config";
import { apiError } from "./response";

export async function authenticate(request: Request, env: Env): Promise<Response | null> {
  const expected = env.DA_SERVICE_TOKEN;
  if (!expected) return null;

  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return apiError("unknown", "UNAUTHORIZED", "Missing or invalid Authorization header", 401);
  }

  const token = header.slice(7);
  if (!token || !(await timingSafeEqual(token, expected))) {
    return apiError("unknown", "INVALID_TOKEN", "Token authentication failed", 401);
  }

  return null;
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  const length = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < length; i++) diff |= (aa[i % aa.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  return diff === 0;
}
