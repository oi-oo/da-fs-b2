export interface StorageObject {
  size: number;
  contentType: string;
  md5: string | null;
  fileId: string | null;
}

export interface StorageVersion {
  fileName: string;
  fileId: string;
}

export interface Storage {
  read(path: string): Promise<Response>;
  write(path: string, body: ReadableStream<Uint8Array>, contentType: string, contentLength?: string | null): Promise<StorageObject>;
  listVersions(path: string): Promise<StorageVersion[]>;
  deleteVersion(version: StorageVersion): Promise<"deleted" | "missing">;
}
