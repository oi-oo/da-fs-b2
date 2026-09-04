export function apiResponse(requestId: string, payload: unknown, status = 200): Response {
  return Response.json({ version: "v1", type: "response", request_id: requestId, payload }, { status });
}

export function apiError(requestId: string, code: string, message: string, status = 400): Response {
  return Response.json({
    version: "v1",
    type: "error",
    request_id: requestId,
    error: { code, message },
  }, { status });
}

export function rawError(code: string, message: string, status = 400): Response {
  return Response.json({ error: { code, message } }, { status });
}

export class FsError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "FsError";
  }
}
