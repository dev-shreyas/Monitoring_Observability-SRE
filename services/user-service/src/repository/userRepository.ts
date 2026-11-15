/**
 * The data layer, behind an interface.
 *
 * Section 6 of the guide puts user-service on Azure SQL. Today this file
 * ships an in-memory implementation so the service runs, builds and tests
 * with zero infrastructure. The interface is the seam: when you are ready
 * for the real thing you add an `AzureSqlUserRepository` implementing the
 * same three methods, and NOTHING in routes/ changes.
 *
 * This is also what makes the tests fast and hermetic — no database needed.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import { getRedis } from "../redisClient";

export interface UserRecord {
  id: string;
  email: string;
  /** bcrypt hash — the plaintext password is never stored or logged. */
  passwordHash: string;
  displayName: string;
  createdAt: string;
}

/** Everything the routes are allowed to ask of storage. */
export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Throws EmailTakenError if the email is already registered — atomically. */
  create(input: { email: string; passwordHash: string; displayName: string }): Promise<UserRecord>;
  /** Used to upgrade a legacy bcrypt hash to scrypt after a successful login. */
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
}

/**
 * Raised by create() when the email is already taken. The CHECK and the WRITE
 * are one atomic step inside the repository, so two simultaneous registrations
 * of the same address cannot both succeed — the route's earlier findByEmail is
 * only a fast path that saves hashing a password for an obvious duplicate.
 */
export class EmailTakenError extends Error {
  constructor() {
    super("An account with that email already exists");
    this.name = "EmailTakenError";
  }
}

export class InMemoryUserRepository implements UserRepository {
  /** Keyed by lowercased email for case-insensitive lookup. */
  private readonly byEmail = new Map<string, UserRecord>();
  private readonly byId = new Map<string, UserRecord>();

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.byEmail.get(email.toLowerCase()) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async create(input: { email: string; passwordHash: string; displayName: string }): Promise<UserRecord> {
    const record: UserRecord = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      createdAt: new Date().toISOString()
    };
    // Check-and-set with no await in between: in single-threaded JS this cannot
    // interleave with another create(), so it is atomic for this store.
    if (this.byEmail.has(record.email)) throw new EmailTakenError();
    this.byEmail.set(record.email, record);
    this.byId.set(record.id, record);
    return record;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.passwordHash = passwordHash;
  }
}

/**
 * Redis-backed storage. This is what runs in Kubernetes.
 *
 * KEY LAYOUT
 * ----------
 *   user:id:<userId>      STRING the account as JSON
 *   user:email:<email>    STRING the userId  (a secondary index)
 *
 * Two keys per account because the service looks accounts up BOTH ways: by email
 * on login, by id on every authenticated request. Redis has no secondary indexes,
 * so one is built explicitly — email -> id -> record, two cheap O(1) GETs.
 *
 * Email keys are lowercased, preserving the case-insensitive lookup the in-memory
 * version had. "Shreyas@x.com" and "shreyas@x.com" are one account.
 */
export class RedisUserRepository implements UserRepository {
  private readonly idKey = (id: string) => `user:id:${id}`;
  private readonly emailKey = (email: string) => `user:email:${email.toLowerCase()}`;

  async findByEmail(email: string): Promise<UserRecord | null> {
    const id = await getRedis().get(this.emailKey(email));
    if (!id) return null;
    return this.findById(id);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const raw = await getRedis().get(this.idKey(id));
    return raw ? (JSON.parse(raw) as UserRecord) : null;
  }

  async create(input: { email: string; passwordHash: string; displayName: string }): Promise<UserRecord> {
    const record: UserRecord = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      createdAt: new Date().toISOString()
    };

    /**
     * CLAIM THE EMAIL ATOMICALLY (this used to be check-then-write, and two
     * simultaneous registrations of one address could both pass the check).
     *
     * Order matters:
     *   1. write the account record under its fresh, unguessable id;
     *   2. SET NX the email key -> id. Redis runs SET NX as one indivisible step,
     *      so exactly one concurrent caller gets "OK";
     *   3. the loser deletes its record and reports 409.
     *
     * Why record FIRST: a crash between the two steps then leaves only an orphan
     * record nobody can reach (harmless). Claiming the email first would risk an
     * email pointing at an id that does not exist — the address could then never
     * register again and never log in.
     */
    const redis = getRedis();
    await redis.set(this.idKey(record.id), JSON.stringify(record));
    const claimed = await redis.set(this.emailKey(record.email), record.id, { NX: true });
    if (claimed !== "OK") {
      await redis.del(this.idKey(record.id));
      throw new EmailTakenError();
    }

    return record;
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const record = await this.findById(id);
    if (!record) return;
    // XX: only overwrite an account that still exists.
    await getRedis().set(this.idKey(id), JSON.stringify({ ...record, passwordHash }), { XX: true });
  }
}

/**
 * Factory. The rest of the app asks for "a repository" and never names a
 * concrete class, so swapping the backend is a one-line change here.
 */
export function createUserRepository(): UserRepository {
  if (config.sqlConnectionString && config.sqlConnectionString !== "dummy-local-connection") {
    // <<< REPLACE ME >>> This is where an Azure SQL implementation goes:
    //   return new AzureSqlUserRepository(config.sqlConnectionString);
    logger.warn("SQL_CONNECTION_STRING is set but no SQL repository is implemented yet; using Redis/in-memory store");
  }

  // Redis when configured (every deployed replica), in-memory otherwise (tests).
  if (config.redisUrl) {
    return new RedisUserRepository();
  }

  // With 2 replicas and no Redis, an account created on one pod does not exist on
  // the other, so logins failed about half the time with "Invalid email or password".
  logger.warn("REDIS_URL is not set; using in-memory store (safe ONLY with a single replica)");
  return new InMemoryUserRepository();
}
