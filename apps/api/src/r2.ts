import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

export const HOUR = 3600;

export const keys = {
  code: "pod/code.tar.gz",
  bootstrap: "pod/bootstrap.sh",
  dataset: (runId: string) => `runs/${runId}/dataset.tar.gz`,
  model: (runId: string) => `runs/${runId}/model.tar`,
};

/** Presigned R2 (S3 API) URL. Only the host is signed, so a PUT accepts any Content-Type. */
export async function presign(env: Env, key: string, method: "GET" | "PUT", expiresSec: number): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${path}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await client.sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}
