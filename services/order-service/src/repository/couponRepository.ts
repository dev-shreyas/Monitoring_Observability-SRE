/**
 * Promotional discount codes. Deliberately tiny and read-mostly — a handful
 * of active codes an ops person edits, not a rules engine. The seam is the
 * same shape as everywhere else in this codebase: an in-memory list today, a
 * real table (Azure SQL, same database as orders — a coupon redemption is
 * part of the same transaction) later.
 */
import { logger } from "../logger";

export type CouponType = "percent" | "flat";

export interface Coupon {
  code: string;
  type: CouponType;
  /** Percent coupons: 0-100. Flat coupons: minor units to take off. */
  value: number;
  description: string;
  active: boolean;
}

export interface CouponRepository {
  findActiveByCode(code: string): Promise<Coupon | null>;
  listActive(): Promise<Coupon[]>;
}

const SEED: Coupon[] = [
  { code: "WELCOME10", type: "percent", value: 10, description: "10% off your order", active: true },
  { code: "FLAT200", type: "flat", value: 20000, description: "₹200 off your order", active: true },
  { code: "SUMMER25", type: "percent", value: 25, description: "25% off your order", active: true }
];

export class InMemoryCouponRepository implements CouponRepository {
  private readonly coupons: Coupon[];

  constructor(seed: Coupon[] = SEED) {
    this.coupons = [...seed];
  }

  async findActiveByCode(code: string): Promise<Coupon | null> {
    const wanted = code.trim().toUpperCase();
    return this.coupons.find((c) => c.code === wanted && c.active) ?? null;
  }

  async listActive(): Promise<Coupon[]> {
    return this.coupons.filter((c) => c.active);
  }
}

export function createCouponRepository(): CouponRepository {
  logger.info("using in-memory coupon repository");
  return new InMemoryCouponRepository();
}

/** Pure function so checkout's math is unit-testable without any repository. */
export function calculateDiscountMinor(coupon: Coupon, subtotalMinor: number): number {
  const raw = coupon.type === "percent" ? Math.round((subtotalMinor * coupon.value) / 100) : coupon.value;
  // Never let a coupon make the order negative — clamp to the subtotal.
  return Math.min(raw, subtotalMinor);
}
