/**
 * Password hashing — OFF the event loop.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Passwords used to be hashed with `bcryptjs`, a pure-JavaScript bcrypt. It is
 * correct but runs ON the main thread: each hash or compare blocked the event
 * loop for ~100ms (more under the pod's 0.5 CPU limit). A burst of logins
 * therefore stalled EVERY request on the pod — /health, /profile, the wishlist —
 * which is what the dashboard showed as event-loop lag spikes and the 1.5s gaps
 * with no spans in /wishlist traces.
 *
 * THE FIX
 * -------
 * Node's built-in `crypto.scrypt` runs in libuv's thread pool, so the event loop
 * keeps serving other requests while a hash is computed. scrypt is also
 * memory-hard (costly to attack on GPUs) and is on OWASP's recommended list.
 * No native addon is needed, so the Alpine/arm64 image builds unchanged.
 *
 * PARAMETERS: N=2^15, r=8, p=1 (32 MiB, ~145 ms of CPU on the dev machine) —
 * the same CPU cost per login as the bcrypt (cost 10, ~133 ms) it replaced.
 * v2.7 shipped N=2^14, r=8, p=5 from OWASP's list; that measured 441 ms — 3.3x
 * the old cost — and a k6 restart (every virtual user logs in again) then
 * saturated the whole kind cluster. OWASP's scrypt minimum is stronger than the
 * current setting; raise N once user-service has more CPU than its 500m limit.
 * Parameters are STORED IN EACH HASH, and any hash whose parameters differ from
 * the current ones is re-hashed on the next successful login, so changing them
 * is safe in both directions:   scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 *
 * MIGRATION: accounts created before this change hold bcrypt hashes ("$2a$...").
 * Those still verify (on the main thread, via bcryptjs) and are re-hashed with
 * scrypt on the next successful login, so bcrypt disappears as people sign in.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import bcrypt from "bcryptjs";

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
/** Node's default maxmem is 32 MiB; 128*N*r = 16 MiB, so 64 MiB leaves headroom. */
const MAX_MEM = 64 * 1024 * 1024;

/**
 * LOAD SHEDDING. Hashing is the most expensive thing this service does. Without a
 * bound, a login burst queues hundreds of hashes, every one finishes long after
 * its client gave up (the proxy times out at 10 s), and the pod keeps burning CPU
 * on answers nobody will read — which is exactly how a k6 restart took the
 * cluster down. So: at most MAX_ACTIVE hashes run at once (libuv's default pool is
 * 4 threads), at most MAX_WAITING wait, and anything beyond that is refused
 * immediately with 503 + Retry-After. Fast refusal beats slow failure.
 */
const MAX_ACTIVE = 4;
const MAX_WAITING = 16;
let active = 0;
const waiting: Array<() => void> = [];

export class HashingBusyError extends Error {
  constructor() {
    super("Password hashing is at capacity");
    this.name = "HashingBusyError";
  }
}

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING) throw new HashingBusyError();
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  return withHashSlot(() => deriveNow(password, salt, opts));
}

function deriveNow(password: string, salt: Buffer, opts: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: opts.N, r: opts.r, p: opts.p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export interface VerifyResult {
  ok: boolean;
  /** True when the stored hash uses an old algorithm or weaker parameters. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  if (stored.startsWith("scrypt$")) {
    const [, n, r, p, saltB64, keyB64] = stored.split("$");
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    const expected = Buffer.from(keyB64 ?? "", "base64");
    if (!Number.isInteger(params.N) || expected.length !== KEY_LENGTH) return { ok: false, needsRehash: false };

    const actual = await derive(password, Buffer.from(saltB64 ?? "", "base64"), params);
    // Constant-time comparison: a byte-by-byte === leaks how many leading bytes
    // matched through response timing.
    const ok = timingSafeEqual(actual, expected);
    return { ok, needsRehash: ok && (params.N !== N || params.r !== R || params.p !== P) };
  }

  if (stored.startsWith("$2")) {
    // Legacy bcrypt — verified once more, then upgraded by the caller.
    const ok = await withHashSlot(() => bcrypt.compare(password, stored));
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}

/**
 * For logins with an UNKNOWN email: spend the same time a real verify would.
 * Returning instantly for unknown accounts and ~100ms for real ones would let
 * anyone discover which emails are registered just by timing the response.
 */
let dummyHash: Promise<string> | null = null;
export async function burnVerifyTime(password: string): Promise<void> {
  dummyHash ??= hashPassword("timing-equaliser-not-a-real-password");
  await verifyPassword(password, await dummyHash);
}
