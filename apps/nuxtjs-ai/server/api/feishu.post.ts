import {
  decryptFeishuEncryptField,
  sliceOuterJsonObject,
  verifyLarkRequestSignature,
} from "../utils/feishuCrypto";

/**
 * 飞书「请求网址校验」成功时 **只能** 返回该 JSON，且 challenge 须与解密/明文请求中一致，无其他字段。
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-configure-/request-url-configuration-case
 */
function feishuChallengeResponse(challenge: string) {
  const body = JSON.stringify({ challenge });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
    },
  });
}

function jsonResponse(data: unknown, status = 200) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
    },
  });
}

export default defineEventHandler(async (event) => {
  const rawString =
    (await readRawBody(event, "utf8").catch(() => undefined)) ?? "";
  if (!rawString.trim()) {
    return jsonResponse({ error: "empty body" }, 400);
  }

  const config = useRuntimeConfig(event);
  const encryptKey = String(config.feishuEncryptKey ?? "").trim();
  const verifyToken = String(config.feishuVerificationToken ?? "").trim();

  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(rawString) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "invalid JSON" }, 400);
  }

  const sig = getHeader(event, "x-lark-signature");
  const ts = getHeader(event, "x-lark-request-timestamp");
  const nonce = getHeader(event, "x-lark-request-nonce");
  if (sig && encryptKey) {
    const ok = verifyLarkRequestSignature(
      rawString,
      ts,
      nonce,
      encryptKey,
      sig,
    );
    if (!ok) return jsonResponse({ error: "invalid signature" }, 403);
  }

  let payload: Record<string, unknown>;

  if (typeof outer.encrypt === "string") {
    if (!encryptKey) {
      return jsonResponse(
        {
          error:
            "request is encrypted; set NUXT_FEISHU_ENCRYPT_KEY to decrypt",
        },
        500,
      );
    }
    try {
      const plain = decryptFeishuEncryptField(outer.encrypt, encryptKey);
      const jsonSlice = sliceOuterJsonObject(plain);
      payload = JSON.parse(jsonSlice) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: "decrypt failed" }, 400);
    }
  } else {
    payload = outer;
  }

  if (payload.type === "url_verification") {
    if (verifyToken && payload.token !== verifyToken) {
      return jsonResponse({ error: "verification token mismatch" }, 403);
    }
    const challenge = payload.challenge;
    if (typeof challenge !== "string") {
      return jsonResponse({ error: "missing challenge" }, 400);
    }
    return feishuChallengeResponse(challenge);
  }

  return jsonResponse({ message: "ignored event type" }, 200);
});
