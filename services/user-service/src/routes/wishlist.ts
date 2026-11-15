/**
 * Saved-for-later products:
 *   GET    /wishlist              the caller's wishlist
 *   POST   /wishlist              save a product { productId }
 *   DELETE /wishlist/:productId   remove a product
 *
 * Every route requires a valid JWT, same rule as order-service's cart: there
 * is no anonymous wishlist, and the user id always comes from the token.
 *
 * requireAuth is applied PER ROUTE (like /profile in routes/users.ts), not
 * via a blanket router.use(). A blanket router.use(requireAuth) here has no
 * path filter, so it would run for every unmatched path that falls through
 * to this router too — turning an unauthenticated request to a nonexistent
 * route into a 401 instead of the 404 notFoundHandler is supposed to give.
 */
import { Router } from "express";
import { notFound } from "../errors";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import type { ProductClient } from "../clients/productClient";
import type { WishlistRepository } from "../repository/wishlistRepository";
import { productId as productIdSchema, validate, z } from "../validation";

const addBody = z.object({ productId: productIdSchema });
const removeParams = z.object({ productId: productIdSchema });

export interface WishlistRouterDeps {
  repository: WishlistRepository;
  productClient: ProductClient;
}

export function createWishlistRouter(deps: WishlistRouterDeps): Router {
  const { repository, productClient } = deps;
  const router = Router();

  router.get("/wishlist", requireAuth, async (req, res, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");

      res.json({ items: await repository.list(userId) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/wishlist", requireAuth, validate({ body: addBody }), async (req, res, next) => {
    try {
      const { productId } = req.body as z.infer<typeof addBody>;

      // Same principle as order-service's cart: confirm the product is real
      // before it enters the wishlist, so the shopper finds out now.
      const product = await productClient.fetchProduct(productId);
      if (!product) throw notFound(`No product with id '${productId}'`);

      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");

      res.status(201).json({ items: await repository.add(userId, productId) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/wishlist/:productId", requireAuth, validate({ params: removeParams }), async (req, res, next) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.sub;
      if (!userId) throw new Error("Unauthorized request: missing user identity");

      // Removing something not on the list is a no-op success, not an error
      // — idempotent DELETE, standard REST practice.
      res.json({ items: await repository.remove(userId, req.params.productId) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
