/**
 * The catalog data layer — the Cosmos DB seam.
 *
 * Why Cosmos and not SQL for this service (guide section 3): the catalog is
 * read-heavy, globally distributed, and its documents are irregular (a
 * laptop and a t-shirt have different attributes). That is a poor fit for
 * rigid relational tables and a good fit for a NoSQL document store.
 */
import { config } from "../config";
import { logger } from "../logger";

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  /** Stored in minor units (paise/cents) as an INTEGER. Never use a float
   *  for money — 0.1 + 0.2 !== 0.3 in binary floating point. */
  priceMinor: number;
  currency: string;
  stock: number;
  imageUrl: string;
}

export interface ProductQuery {
  category?: string;
  /** Free-text search across name, description and SKU. */
  q?: string;
  limit: number;
  offset: number;
}

export interface ProductPage {
  items: Product[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProductRepository {
  list(query: ProductQuery): Promise<ProductPage>;
  findById(id: string): Promise<Product | null>;
}

/**
 * Seed catalog. In a real deployment this data lives in Cosmos and is loaded
 * by a seeding job; here it is inline so the service is useful the moment it
 * starts, with no external dependency.
 */
const SEED: Product[] = [
  { id: "p-1001", sku: "LAP-14-SLV",  name: "Aether 14 Laptop",               description: "14-inch ultralight laptop, 16GB RAM, 512GB SSD.", category: "electronics", priceMinor: 8999900, currency: "INR", stock: 12, imageUrl: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1002", sku: "HDP-OE-BLK",  name: "Nimbus Over-Ear Headphones",     description: "Active noise cancelling, 40h battery.",          category: "electronics", priceMinor: 1249900, currency: "INR", stock: 87, imageUrl: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1003", sku: "TSH-M-NVY",   name: "Everyday T-Shirt",               description: "Organic cotton crew neck, navy, medium.",        category: "apparel",     priceMinor:   79900, currency: "INR", stock: 240, imageUrl: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1004", sku: "MUG-350-WHT", name: "Ceramic Mug 350ml",              description: "Dishwasher-safe stoneware mug.",                 category: "home",        priceMinor:   49900, currency: "INR", stock: 0, imageUrl: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1005", sku: "KBD-TKL-RGB", name: "Tenkeyless Mechanical Keyboard", description: "Hot-swappable switches, USB-C, RGB.",            category: "electronics", priceMinor:  649900, currency: "INR", stock: 34, imageUrl: "https://images.unsplash.com/photo-1511467687858-23d96c32e4ae?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1006", sku: "BKS-DEVOPS",  name: "The DevOps Handbook",            description: "Paperback, 480 pages.",                          category: "books",       priceMinor:  129900, currency: "INR", stock: 56, imageUrl: "https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1007", sku: "AIR-PS-BLU",  name: "Aero Pro Smartwatch",           description: "Track workouts, sleep and notifications with style.", category: "electronics", priceMinor:  499900, currency: "INR", stock: 81, imageUrl: "https://images.unsplash.com/photo-1546868871-7041f2a55e12?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1008", sku: "JKT-LN-ASH",  name: "Luma Light Jacket",             description: "Water-resistant shell with a minimalist silhouette.", category: "apparel", priceMinor:  249900, currency: "INR", stock: 92, imageUrl: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1009", sku: "LAM-LED",     name: "Halo Desk Lamp",                description: "Warm ambient lighting and USB-C charging dock.", category: "home", priceMinor:  179900, currency: "INR", stock: 64, imageUrl: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1010", sku: "BAG-TRV-BLK", name: "Drift Travel Pack",             description: "Carry-on friendly backpack built for fast city hops.", category: "home", priceMinor:  349900, currency: "INR", stock: 44, imageUrl: "https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1011", sku: "JNL-MLT",     name: "Minimal Journal",               description: "Dot-grid notebook for planning and sketches.", category: "books", priceMinor:  69900, currency: "INR", stock: 180, imageUrl: "https://images.unsplash.com/photo-1455390582262-044cdead277a?auto=format&fit=crop&w=900&q=80" },
  { id: "p-1012", sku: "CAM-4K",      name: "Aurora 4K Camera",              description: "Pocket-friendly creator camera with crisp detail.", category: "electronics", priceMinor:  1499900, currency: "INR", stock: 19, imageUrl: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=900&q=80" }
];

/**
 * Starting stock per product. Since P1.1 the LIVE stock level is owned by the
 * StockStore (stockStore.ts), not by these records: this map only seeds a
 * product's counter the first time it is touched.
 */
export const SEED_STOCK: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(SEED.map((p) => [p.id, p.stock]))
);

export class InMemoryProductRepository implements ProductRepository {
  private readonly products: Product[];

  constructor(seed: Product[] = SEED) {
    // Copy the array so a caller mutating their seed cannot mutate our state.
    this.products = [...seed];
  }

  async list(query: ProductQuery): Promise<ProductPage> {
    let matches = this.products;

    if (query.category) {
      const wanted = query.category.toLowerCase();
      matches = matches.filter((p) => p.category.toLowerCase() === wanted);
    }

    if (query.q) {
      // Naive substring search. Cosmos DB would use CONTAINS() in its SQL API,
      // or you would front this with Azure AI Search for real relevance.
      const needle = query.q.toLowerCase();
      matches = matches.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.description.toLowerCase().includes(needle) ||
          p.sku.toLowerCase().includes(needle)
      );
    }

    // total is computed BEFORE paging so the client can render "1-20 of 137".
    return {
      total: matches.length,
      items: matches.slice(query.offset, query.offset + query.limit),
      limit: query.limit,
      offset: query.offset
    };
  }

  async findById(id: string): Promise<Product | null> {
    return this.products.find((p) => p.id === id) ?? null;
  }
}

export function createProductRepository(): ProductRepository {
  if (config.cosmos.endpoint) {
    // <<< REPLACE ME >>> A Cosmos implementation goes here:
    //   const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
    //   return new CosmosProductRepository(client);
    logger.warn("COSMOS_ENDPOINT is set but no Cosmos repository is implemented yet; using in-memory catalog");
  }
  return new InMemoryProductRepository();
}
