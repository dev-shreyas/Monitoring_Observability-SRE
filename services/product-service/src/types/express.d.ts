/**
 * Type-only file. It teaches TypeScript that our auth middleware adds a
 * `user` property to Express's Request object. Without this, every
 * `req.user` in a route handler would be a compile error.
 *
 * It emits no JavaScript — it exists purely for the compiler.
 */
declare global {
  namespace Express {
    interface Request {
      user?: {
        sub: string; // the user id ("subject" of the token)
        email: string;
      };
    }
  }
}

export {};
