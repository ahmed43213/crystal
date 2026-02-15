import fs from "fs";

const FILE = "./coupons.json";

function readAll() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(arr) {
  fs.writeFileSync(FILE, JSON.stringify(arr, null, 2), "utf8");
}

export function listCoupons() {
  return readAll();
}

export function findCoupon(code) {
  if (!code) return null;
  const c = readAll().find(x => String(x.code).toLowerCase() === String(code).toLowerCase());
  if (!c) return null;
  if (c.active === false) return null;
  if (Number(c.maxUses) > 0 && Number(c.uses) >= Number(c.maxUses)) return null;
  return c;
}

export function addCoupon({ code, type, value, maxUses }) {
  if (!code) throw new Error("Missing code");
  const norm = String(code).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(norm)) throw new Error("Code must be 2-32 chars (A-Z, 0-9, _ or -)");

  if (type !== "fixed" && type !== "percent") throw new Error("Type must be fixed or percent");

  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) throw new Error("Value must be > 0");
  if (type === "percent" && v > 100) throw new Error("Percent cannot exceed 100");

  const m = Number(maxUses ?? 0);
  if (!Number.isFinite(m) || m < 0) throw new Error("maxUses must be >= 0 (0 = unlimited)");

  const arr = readAll();
  if (arr.some(x => String(x.code).toUpperCase() === norm)) throw new Error("Coupon already exists");

  const coupon = {
    code: norm,
    type,
    value: v,
    uses: 0,
    maxUses: m,
    active: true,
    createdAt: new Date().toISOString(),
  };

  arr.push(coupon);
  writeAll(arr);
  return coupon;
}

export function deleteCoupon(code) {
  const norm = String(code || "").trim().toUpperCase();
  const arr = readAll();
  const before = arr.length;
  const next = arr.filter(x => String(x.code).toUpperCase() !== norm);
  writeAll(next);
  return next.length !== before;
}

export function incrementCouponUse(code) {
  const norm = String(code || "").trim().toUpperCase();
  const arr = readAll();
  const idx = arr.findIndex(x => String(x.code).toUpperCase() === norm);
  if (idx === -1) return false;

  const c = arr[idx];
  if (c.active === false) return false;

  const maxUses = Number(c.maxUses || 0);
  const uses = Number(c.uses || 0);

  if (maxUses > 0 && uses >= maxUses) return false;

  c.uses = uses + 1;
  arr[idx] = c;
  writeAll(arr);
  return true;
}

export function applyCouponToAmount(amountUsd, coupon) {
  const amount = Number(amountUsd);
  if (!coupon) return { total: amount, discount: 0, label: null };

  if (coupon.type === "fixed") {
    const discount = Math.max(0, Math.min(amount, Number(coupon.value)));
    return {
      total: Number((amount - discount).toFixed(2)),
      discount: Number(discount.toFixed(2)),
      label: `${coupon.code} (-$${discount.toFixed(2)})`,
    };
  }

  if (coupon.type === "percent") {
    const pct = Math.max(0, Math.min(100, Number(coupon.value)));
    const discount = amount * (pct / 100);
    return {
      total: Number((amount - discount).toFixed(2)),
      discount: Number(discount.toFixed(2)),
      label: `${coupon.code} (-${pct}%)`,
    };
  }

  return { total: amount, discount: 0, label: null };
}
