import type { Env } from "./config";
import type { Storage, StorageObject } from "./storage";

interface B2Auth {
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
}

interface B2Version {
  fileName: string;
  fileId: string;
}

const AUTH_CACHE_KEY = "da-fs-b2-auth";

export class B2Storage implements Storage {
  private authPromise?: Promise<B2Auth>;

  constructor(private env: Env, private ctx: ExecutionContext) {}

  async read(path: string): Promise<Response> {
    let response = await this.download(await this.getAuth(), path);
    if (response.status === 401) {
      await this.refreshAuth();
      response = await this.download(await this.getAuth(), path);
    }
    return response;
  }

  async write(path: string, body: ReadableStream<Uint8Array>, contentType: string, contentLength?: string | null): Promise<StorageObject> {
    const response = await this.upload(await this.getAuth(), path, body, contentType, contentLength);
    if (response.status === 401) {
      await this.refreshAuth();
      throw new Error("B2 authentication expired during upload; retry operation");
    }
    if (!response.ok) throw new Error(`B2 upload failed (${response.status})`);
    const result = await response.json() as any;
    return {
      size: Number(result.contentLength ?? contentLength ?? 0),
      contentType,
      md5: result.contentMd5 || null,
      fileId: result.fileId || null,
    };
  }

  async delete(path: string): Promise<void> {
    let auth = await this.getAuth();
    let versions = await this.listAllVersions(auth, path);
    if (versions === null) {
      await this.refreshAuth();
      auth = await this.getAuth();
      versions = await this.listAllVersions(auth, path);
    }

    // B2 stores multiple versions under one filename. DA delete means removing
    // the backend representation completely, so all B2 versions are removed here.
    for (const version of versions) {
      let response = await this.deleteOne(auth, version);
      if (response.status === 401) {
        await this.refreshAuth();
        auth = await this.getAuth();
        response = await this.deleteOne(auth, version);
      }
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`B2 delete failed (${response.status})`);
    }
  }

  private async getAuth(): Promise<B2Auth> {
    if (!this.authPromise) this.authPromise = this.loadAuth();
    return this.authPromise;
  }

  private async refreshAuth() {
    this.authPromise = undefined;
    await caches.default.delete(new Request(`https://cache.invalid/${AUTH_CACHE_KEY}`));
  }

  private async loadAuth(): Promise<B2Auth> {
    const cache = caches.default;
    const cacheRequest = new Request(`https://cache.invalid/${AUTH_CACHE_KEY}`);
    const cached = await cache.match(cacheRequest);
    if (cached) return await cached.json() as B2Auth;

    const credentials = btoa(`${this.env.B2_KEY_ID}:${this.env.B2_APPLICATION_KEY}`);
    const response = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      headers: { Authorization: `Basic ${credentials}` },
    });
    if (!response.ok) throw new Error(`B2 authorization failed (${response.status})`);
    const auth = await response.json() as B2Auth;
    this.ctx.waitUntil(cache.put(cacheRequest, new Response(JSON.stringify(auth), { headers: { "Cache-Control": "max-age=1800" } })));
    return auth;
  }

  private download(auth: B2Auth, path: string) {
    return fetch(`${auth.downloadUrl}/file/${encodeURIComponent(this.env.B2_BUCKET_NAME)}/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
      headers: { Authorization: auth.authorizationToken },
    });
  }

  private async upload(auth: B2Auth, path: string, body: ReadableStream<Uint8Array>, contentType: string, contentLength?: string | null) {
    const urlResponse = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: "POST",
      headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ bucketId: this.env.B2_BUCKET_ID }),
    });
    if (!urlResponse.ok) return urlResponse;
    const info = await urlResponse.json() as { uploadUrl: string; authorizationToken: string };
    const headers: Record<string, string> = {
      Authorization: info.authorizationToken,
      "X-Bz-File-Name": encodeURIComponent(path),
      "Content-Type": contentType,
      "X-Bz-Content-Sha1": "do_not_verify",
    };
    if (contentLength) headers["Content-Length"] = contentLength;
    return fetch(info.uploadUrl, { method: "POST", headers, body });
  }

  private async listAllVersions(auth: B2Auth, path: string): Promise<B2Version[] | null> {
    const versions: B2Version[] = [];
    let startFileName: string | undefined;
    let startFileId: string | undefined;
    do {
      const body: Record<string, unknown> = { bucketId: this.env.B2_BUCKET_ID, prefix: path, maxFileCount: 1000 };
      if (startFileName) body.startFileName = startFileName;
      if (startFileId) body.startFileId = startFileId;
      const response = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_file_versions`, {
        method: "POST",
        headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 401) return null;
      if (!response.ok) throw new Error(`B2 list versions failed (${response.status})`);
      const result = await response.json() as any;
      for (const file of result.files || []) {
        if (file.fileName === path) versions.push({ fileName: file.fileName, fileId: file.fileId });
      }
      startFileName = result.nextFileName;
      startFileId = result.nextFileId;
    } while (startFileName);
    return versions;
  }

  private deleteOne(auth: B2Auth, version: B2Version) {
    return fetch(`${auth.apiUrl}/b2api/v2/b2_delete_file_version`, {
      method: "POST",
      headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: version.fileName, fileId: version.fileId }),
    });
  }
}
