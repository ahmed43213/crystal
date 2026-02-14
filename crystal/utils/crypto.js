import fetch from "node-fetch";
import crypto from "crypto";

function getEnv(env) {
  const merchant =
    env.CRYPTOMUS_MERCHANT_UUID ||
    env.CRYPTOMUS_MERCHANT ||
    env.CRYPTOMUS_MERCHAN ||
    "";
  const apiKey = env.CRYPTOMUS_API_KEY || "";
  return { merchant, apiKey };
}

function makeSign(bodyObj, apiKey) {
  // Cryptomus: sign = md5(base64(json) + apiKey)
  const json = JSON.stringify(bodyObj ?? {});
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return crypto.createHash("md5").update(base64 + apiKey).digest("hex");
}

export async function createCryptomusInvoice({
  amountUsd,
  orderId,
  description,
  successUrl,
  callbackUrl,
  env,
}) {
  const { merchant, apiKey } = getEnv(env);
  if (!merchant) throw new Error("Missing CRYPTOMUS_MERCHANT_UUID");
  if (!apiKey) throw new Error("Missing CRYPTOMUS_API_KEY");

  const body = {
    amount: String(Number(amountUsd).toFixed(2)),
    currency: "USD",
    order_id: orderId,
    url_return: successUrl || undefined,
    url_callback: callbackUrl || undefined,
    is_payment_multiple: false,
    lifetime: 3600,
    additional_data: description || "",
  };

  const sign = makeSign(body, apiKey);

  const res = await fetch("https://api.cryptomus.com/v1/payment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      merchant,
      sign,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.result?.url) {
    const msg = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Cryptomus invoice failed: ${msg}`);
  }

  return { url: data.result.url, uuid: data.result.uuid, data };
}

export function isCryptomusWebhookTrusted(req, env) {
  // التحقق الحقيقي للويبهوك يكون بمقارنة sign القادم في body
  // مع sign محسوب من body بدون sign + API key :contentReference[oaicite:1]{index=1}
  const apiKey = env.CRYPTOMUS_API_KEY;
  if (!apiKey) return true;

  const payload = req.body || {};
  const received = payload.sign;
  if (!received) return false;

  const copy = { ...payload };
  delete copy.sign;

  const json = JSON.stringify(copy ?? {});
  const base64 = Buffer.from(json, "utf8").toString("base64");
  const expected = crypto.createHash("md5").update(base64 + apiKey).digest("hex");

  return expected === received;
}
