/**
 * Tencent COS single-object upload for IMA's create_media credential.
 * IMA hands back a temporary key pair, so the request is signed here instead of
 * taking a COS SDK dependency for one PUT.
 */
import { createHash, createHmac } from "node:crypto";

export type CosCredential = {
  token: string;
  secret_id: string;
  secret_key: string;
  start_time?: number;
  expired_time?: number;
  bucket_name: string;
  region: string;
  cos_key: string;
  custom_domain?: string;
};

function hmacSha1(key: string, data: string): string {
  return createHmac("sha1", key).update(data).digest("hex");
}

function sha1(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Signature for a PUT Object request. Header names are sorted and lowercased. */
export function cosAuthorization(input: {
  secretId: string;
  secretKey: string;
  method: string;
  pathname: string;
  headers: Record<string, string>;
  startTime: number;
  expiredTime: number;
}): string {
  const keyTime = `${input.startTime};${input.expiredTime}`;
  const signKey = hmacSha1(input.secretKey, keyTime);
  const names = Object.keys(input.headers).sort();
  const httpHeaders = names
    .map((name) => `${name.toLowerCase()}=${encodeURIComponent(input.headers[name] ?? "")}`)
    .join("&");
  const httpString = `${input.method.toLowerCase()}\n${input.pathname}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${input.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${names.map((name) => name.toLowerCase()).join(";")}`,
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
}

export function cosHost(credential: Pick<CosCredential, "bucket_name" | "region">): string {
  return `${credential.bucket_name}.cos.${credential.region}.myqcloud.com`;
}

/** PUTs the bytes and returns nothing: IMA only needs the object to exist. */
export async function uploadToCos(input: {
  credential: CosCredential;
  body: Uint8Array;
  contentType: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<void> {
  const { credential } = input;
  const now = input.now ?? Date.now;
  const startTime = credential.start_time ?? Math.floor(now() / 1000);
  const expiredTime = credential.expired_time ?? Math.floor(now() / 1000) + 3600;
  const host = cosHost(credential);
  const pathname = `/${credential.cos_key}`;
  const authorization = cosAuthorization({
    secretId: credential.secret_id,
    secretKey: credential.secret_key,
    method: "PUT",
    pathname,
    headers: { "content-length": String(input.body.length), host },
    startTime,
    expiredTime,
  });
  const domain = credential.custom_domain?.trim();
  const target = `https://${domain ? domain : host}${pathname}`;
  const response = await (input.fetchImpl ?? fetch)(target, {
    method: "PUT",
    headers: {
      "content-type": input.contentType,
      "content-length": String(input.body.length),
      authorization,
      "x-cos-security-token": credential.token,
    },
    body: input.body,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`文件上传到 COS 失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
  }
}
