import fs from "fs";

const FILE = "./data/pending_coupons.json";

export function ensurePendingCouponsFile() {
  try {
    fs.mkdirSync("./data", { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({}, null, 2), "utf8");
  } catch {}
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeAll(obj) {
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), "utf8");
}

export function setPendingCoupon(channelId, coupon) {
  const obj = readAll();
  obj[channelId] = coupon; // { code, type, value, maxUses }
  writeAll(obj);
}

export function getPendingCoupon(channelId) {
  const obj = readAll();
  return obj[channelId] || null;
}

export function clearPendingCoupon(channelId) {
  const obj = readAll();
  if (obj[channelId]) {
    delete obj[channelId];
    writeAll(obj);
  }
}
