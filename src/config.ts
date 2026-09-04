export const API_VERSION = "v1";
export const SERVICE_NAME = "da-fs-b2";

export interface Env {
  DB: D1Database;
  DA_SERVICE_TOKEN?: string;
  DA_INSTANCE_ID?: string;
  B2_KEY_ID: string;
  B2_APPLICATION_KEY: string;
  B2_BUCKET_ID: string;
  B2_BUCKET_NAME: string;
}

export function getConfig(env: Env) {
  return {
    serviceToken: env.DA_SERVICE_TOKEN,
    instanceId: env.DA_INSTANCE_ID,
    b2BucketId: env.B2_BUCKET_ID,
    b2BucketName: env.B2_BUCKET_NAME,
  };
}
