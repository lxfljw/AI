import { createDecipheriv, createHash } from "node:crypto";

/** Encrypt Key → AES-256-CBC 密钥（SHA256 摘要） */
function feishuAesKey(encryptKey: string): Buffer {
  return createHash("sha256").update(encryptKey, "utf8").digest();
}

/**
 * 解密飞书事件里的 `encrypt` 字段（Base64(iv(16) + ciphertext)）。
 * @see https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function decryptFeishuEncryptField(
  encryptBase64: string,
  encryptKey: string,
): string {
  const key = feishuAesKey(encryptKey);
  const buf = Buffer.from(encryptBase64, "base64");
  if (buf.length < 17) throw new Error("cipher too short");
  const iv = buf.subarray(0, 16);
  const ciphertext = buf.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** 明文里可能带填充噪声，截取首尾 `{}` 之间的 JSON（与官方 Go 示例一致） */
export function sliceOuterJsonObject(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start)
    throw new Error("no JSON object in decrypted plaintext");
  return s.slice(start, end + 1);
}

/** 配置 Encrypt Key 时校验请求是否来自飞书（原始 body 字符串参与哈希） */
export function verifyLarkRequestSignature(
  rawBody: string,
  timestamp: string | undefined,
  nonce: string | undefined,
  encryptKey: string,
  signature: string | undefined,
): boolean {
  if (!signature || !timestamp || !nonce) return false;
  const content = `${timestamp}${nonce}${encryptKey}${rawBody}`;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return hash === signature;
}
