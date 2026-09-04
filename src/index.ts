import type { Env } from "./config";
import { SERVICE_NAME } from "./config";
import { authenticate } from "./auth";
import { apiError } from "./response";
import { B2Storage } from "./b2";
import { handleApi, handleRaw } from "./api";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "GET") return new Response(`DA Filesystem service: ${SERVICE_NAME}`, { status: 200 });
    if (request.method !== "POST") return apiError("unknown", "METHOD_NOT_ALLOWED", "Method not allowed", 405);

    const authError = await authenticate(request, env);
    if (authError) return authError;

    const url = new URL(request.url);
    const storage = new B2Storage(env, ctx);

    try {
      if (url.pathname === "/api") {
        if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) {
          return apiError("unknown", "INVALID_CONTENT_TYPE", "Expected application/json", 400);
        }
        return await handleApi(request, env, storage);
      }
      if (url.pathname === "/raw") return await handleRaw(request, env, storage);
      return apiError("unknown", "NOT_FOUND", "Endpoint not found", 404);
    } catch (error: any) {
      console.error("Filesystem service error:", error);
      return apiError("unknown", "INTERNAL_ERROR", error?.message || "Internal error", 500);
    }
  },
};
