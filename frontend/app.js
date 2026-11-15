// Relative paths only. nginx.conf proxies each route to its owning service
// by exact path (no rewriting needed — /register, /products, /cart etc. are
// already the services' own root-level route names), so the browser never
// needs to know a service's host or port and there is no CORS to configure.
const API = {
  user: '',
  product: '',
  order: ''
};

const state = {
  page: 'home',
  authMode: 'login',
  products: [],
  filteredProducts: [],
  cart: [],
  orders: [],
  wishlist: [],
  availableCoupons: [],
  currentProductId: null,
  token: localStorage.getItem('aetherToken') || '',
  user: JSON.parse(localStorage.getItem('aetherUser') || 'null'),
  selectedCategory: 'all',
  searchQuery: '',
  sortMode: 'featured'
};

const RELEASE_NOTES = [
  {
    version: 'v2.8.0',
    date: '2026-11-12',
    latest: true,
    tags: [{ label: 'New', type: 'feature' }, { label: 'Improved', type: 'improvement' }],
    title: 'Real stock and order tracking',
    items: [
      'Stock is now real: when something sells out it is gone, so you can never order an item we do not have.',
      'Stock levels on product pages are live and change as other shoppers buy.',
      'If two people try to buy the last one at the same moment, only one order goes through. The other shopper gets a clear "sold out" message.',
      'Each order now shows its journey: Awaiting payment, Confirmed, Packed, Shipped, Delivered, with the time of every step.',
      'Cancel an order any time before it is packed. The item goes straight back on the shelf for someone else.',
      'When the shop is very busy, signing in now asks you to try again in a moment instead of hanging.'
    ]
  },
  {
    version: 'v2.7.0',
    date: '2026-11-12',
    tags: [
      { label: 'Security', type: 'security' },
      { label: 'Fix', type: 'fix' },
      { label: 'Improved', type: 'improvement' }
    ],
    title: 'Safer sign-in and checkout',
    items: [
      'Please sign in again once: we replaced the key that protects your sign-in, so earlier sessions have ended.',
      'When a session ends, the shop now asks you to sign in again, instead of looking signed in while your cart and orders fail to load.',
      'Pressing "Place order" twice, or retrying after a dropped connection, can no longer create a second order. You get the order you already placed.',
      'Posting a product review works again. Reviews were being turned away with "Invalid or expired token".',
      'Your account is protected from password guessing: after 5 wrong passwords in a row, sign-in for that account pauses for 15 minutes.',
      'Passwords are now stored with a stronger, modern method. Yours keeps working and is upgraded automatically the next time you sign in.',
      'The shop stays responsive while lots of people are signing in at the same time.',
      'When something you entered is not accepted, the message now says which field and why.',
      'Two sign-ups with the same email at the same moment can no longer both succeed.',
      'Added browser protections that block injected scripts and stop other sites from embedding the shop.'
    ]
  },
  {
    version: 'v2.6.0',
    date: '2026-11-11',
    tags: [{ label: 'Fix', type: 'fix' }, { label: 'Improved', type: 'improvement' }],
    title: 'Your cart and account now stay put',
    items: [
      'Checkout no longer says your cart is empty when it is not. Items you add are kept safely and are there when you pay.',
      'Signing in works straight after you create an account, every time.',
      'Your cart, wishlist and order history survive a restart of the store, so nothing is lost behind the scenes.',
      'Saving something to your wishlist twice no longer moves it to the bottom of the list.',
      'Order history loads faster, and newest orders are always listed first.',
      'Abandoned carts are now kept for 7 days before being cleared.'
    ]
  },
  {
    version: 'v2.5.0',
    date: '2026-09-01',
    tags: [{ label: 'New', type: 'feature' }],
    title: 'Reviews, wishlists, coupons, and order cancellation',
    items: [
      'Rate and review any product — every product now shows a real average rating and review count.',
      'Save items to a wishlist from anywhere in the catalog and pick up where you left off.',
      'Apply a coupon code at checkout (try WELCOME10, FLAT200, or SUMMER25) for an instant discount.',
      'Changed your mind? Cancel an order yourself, right up until it ships.',
      'Category filters are now backed by a real endpoint instead of being guessed from the current page of products.'
    ]
  },
  {
    version: 'v2.4.0',
    date: '2026-08-31',
    tags: [{ label: 'New', type: 'feature' }],
    title: 'Dark mode & a fresh "What\'s New" tab',
    items: [
      'Added a one-click dark mode toggle that remembers your preference.',
      'Introduced this release notes tab so you always know what shipped.',
      'Smoother hover animations across product, category, and feature cards.'
    ]
  },
  {
    version: 'v2.3.0',
    date: '2026-07-18',
    tags: [{ label: 'Improved', type: 'improvement' }],
    title: 'Faster catalog browsing',
    items: [
      'Category filters and sort now update instantly without a page flash.',
      'Product cards show live stock badges (New / Sold out).',
      'Search now also matches product descriptions, not just titles.'
    ]
  },
  {
    version: 'v2.2.0',
    date: '2026-06-02',
    tags: [{ label: 'New', type: 'feature' }],
    title: 'Order tracking dashboard',
    items: [
      'Added the Orders tab with live status, totals, and item counts.',
      'Checkout now redirects straight to your latest order summary.'
    ]
  },
  {
    version: 'v2.1.1',
    date: '2026-05-10',
    tags: [{ label: 'Fix', type: 'fix' }],
    title: 'Cart reliability fixes',
    items: [
      'Fixed a bug where quantity changes could briefly desync from the server.',
      'Resolved an issue where the cart badge count lagged after checkout.'
    ]
  },
  {
    version: 'v2.1.0',
    date: '2026-03-22',
    tags: [{ label: 'New', type: 'feature' }],
    title: 'Account profiles',
    items: [
      'Added login/register with persistent sessions.',
      'New profile page showing your account details at a glance.'
    ]
  }
];

const els = {
  navToggle: document.getElementById('navToggle'),
  themeToggle: document.getElementById('themeToggle'),
  releasesTimeline: document.getElementById('releasesTimeline'),
  authButton: document.getElementById('authButton'),
  cartButton: document.getElementById('cartButton'),
  cartCount: document.getElementById('cartCount'),
  cartDrawer: document.getElementById('cartDrawer'),
  cartBackdrop: document.getElementById('cartBackdrop'),
  closeCartButton: document.getElementById('closeCartButton'),
  closeMobileMenuButton: document.getElementById('closeMobileMenuButton'),
  checkoutButton: document.getElementById('checkoutButton'),
  couponInput: document.getElementById('couponInput'),
  couponChips: document.getElementById('couponChips'),
  wishlistButton: document.getElementById('wishlistButton'),
  wishlistCount: document.getElementById('wishlistCount'),
  wishlistDrawer: document.getElementById('wishlistDrawer'),
  wishlistItems: document.getElementById('wishlistItems'),
  closeWishlistButton: document.getElementById('closeWishlistButton'),
  mobileWishlistLink: document.getElementById('mobileWishlistLink'),
  authModal: document.getElementById('authModal'),
  productModal: document.getElementById('productModal'),
  mobileMenu: document.getElementById('mobileMenu'),
  authForm: document.getElementById('authForm'),
  emailInput: document.getElementById('emailInput'),
  passwordInput: document.getElementById('passwordInput'),
  displayNameInput: document.getElementById('displayNameInput'),
  displayNameWrap: document.getElementById('displayNameWrap'),
  searchInput: document.getElementById('searchInput'),
  categoryTabs: document.getElementById('categoryTabs'),
  catalogGrid: document.getElementById('catalogGrid'),
  cartItems: document.getElementById('cartItems'),
  subtotalValue: document.getElementById('subtotalValue'),
  totalValue: document.getElementById('totalValue'),
  ordersList: document.getElementById('ordersList'),
  profileName: document.getElementById('profileName'),
  profileEmail: document.getElementById('profileEmail'),
  logoutButton: document.getElementById('logoutButton'),
  productDetailLayout: document.getElementById('productDetailLayout'),
  toast: document.getElementById('toast'),
  featuredGrid: document.getElementById('featuredGrid'),
  catalogCount: document.getElementById('catalogCount'),
  sortSelect: document.getElementById('sortSelect')
};

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0
});

function formatPrice(value) {
  return currency.format(value / 100);
}

function renderStars(average) {
  const rounded = Math.round(average);
  return '★'.repeat(rounded) + '☆'.repeat(5 - rounded);
}

function renderRatingLine(rating) {
  if (!rating || rating.count === 0) {
    return '<span class="rating-line muted">No reviews yet</span>';
  }
  return `<span class="rating-line"><span class="stars">${renderStars(rating.average)}</span> ${rating.average.toFixed(1)} (${rating.count})</span>`;
}

function showToast(message, type = 'success') {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.className = `toast show ${type}`;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => {
    els.toast.className = 'toast';
  }, 2200);
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-mode', isDark);
  if (els.themeToggle) {
    els.themeToggle.textContent = isDark ? '☀️' : '🌙';
  }
  localStorage.setItem('aetherTheme', theme);
}

function toggleTheme() {
  const isDark = document.body.classList.contains('dark-mode');
  applyTheme(isDark ? 'light' : 'dark');
}

function renderReleaseNotes() {
  if (!els.releasesTimeline) return;

  els.releasesTimeline.innerHTML = RELEASE_NOTES.map((release) => {
    const tags = release.tags
      .map((tag) => `<span class="release-tag ${tag.type}">${tag.label}</span>`)
      .join('');
    const items = release.items.map((item) => `<li>${item}</li>`).join('');
    const formattedDate = new Date(release.date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    return `
      <article class="release-entry reveal ${release.latest ? 'latest' : ''}">
        <div class="release-head">
          <span class="release-version">${release.version}</span>
          ${tags}
          <span class="release-date">${formattedDate}</span>
        </div>
        <h3 class="release-title">${release.title}</h3>
        <ul>${items}</ul>
      </article>
    `;
  }).join('');

  observeReveals();
}

let revealObserver;

function observeReveals() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in-view'));
    return;
  }

  if (!revealObserver) {
    revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
  }

  document.querySelectorAll('.reveal:not(.in-view)').forEach((el) => revealObserver.observe(el));
}

function setPage(targetPage) {
  state.page = targetPage;
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', page.id === `${targetPage}Page`);
  });

  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.pageTarget === targetPage);
  });

  document.querySelectorAll('.mobile-nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.pageTarget === targetPage);
  });

  if (els.mobileMenu) {
    els.mobileMenu.classList.remove('open');
  }
}

// Cart, wishlist and the mobile nav are mutually exclusive drawers sharing
// one backdrop. Each toggle function only ever touches its OWN drawer's open
// class directly; backdrop visibility is always recomputed from actual DOM
// state afterwards, so closing one drawer can never accidentally hide the
// backdrop out from under another one that is still open.
function syncBackdrop() {
  const anyOpen =
    els.cartDrawer.classList.contains('open') ||
    Boolean(els.wishlistDrawer?.classList.contains('open')) ||
    Boolean(els.mobileMenu?.classList.contains('open'));
  els.cartBackdrop.classList.toggle('visible', anyOpen);
}

function toggleCart(open) {
  els.cartDrawer.classList.toggle('open', open);
  if (open) {
    toggleWishlistDrawer(false);
    toggleMobileNav(false);
  }
  syncBackdrop();
}

function toggleWishlistDrawer(open) {
  if (!els.wishlistDrawer) return;
  els.wishlistDrawer.classList.toggle('open', open);
  if (open) {
    toggleCart(false);
    toggleMobileNav(false);
  }
  syncBackdrop();
}

function toggleMobileNav(open) {
  if (!els.mobileMenu) return;
  els.mobileMenu.classList.toggle('open', open);
  if (open) {
    toggleCart(false);
    toggleWishlistDrawer(false);
  }
  syncBackdrop();
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  els.displayNameWrap.classList.toggle('hidden', !isRegister);
  document.getElementById('authTitle').textContent = isRegister ? 'Create account' : 'Login to continue';
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.authMode === mode);
  });
}

function showAuthModal() {
  els.authModal.classList.remove('hidden');
}

function hideAuthModal() {
  els.authModal.classList.add('hidden');
}

function hideProductModal() {
  els.productModal.classList.add('hidden');
}

async function showProductModal(product) {
  state.currentProductId = product.id;

  els.productDetailLayout.innerHTML = `
    <div class="product-hero-image" style="background-image: url('${product.imageUrl}')"></div>
    <div class="product-detail-copy">
      <span class="eyebrow">${product.category}</span>
      <h2>${product.name}</h2>
      ${renderRatingLine(product.rating)}
      <div class="product-detail-price">${formatPrice(product.priceMinor)}</div>
      <div class="stock-pill">${product.stock > 0 ? 'In stock' : 'Out of stock'} · ${product.stock} left</div>
      <p>${product.description}</p>
      <div class="product-actions" style="margin-top: 24px; gap: 12px;">
        <button class="primary-btn" data-product-add="${product.id}">Add to cart</button>
        <button class="icon-btn wish-toggle${isWishlisted(product.id) ? ' active' : ''}" data-wishlist-toggle="${product.id}" aria-label="Save to wishlist">${isWishlisted(product.id) ? '♥' : '♡'}</button>
        <button class="secondary-btn" data-close-modal="productModal">Continue browsing</button>
      </div>

      <div class="reviews-section">
        <h3>Reviews</h3>
        <div id="reviewsList" class="reviews-list"><p class="muted">Loading reviews…</p></div>
        ${
          state.token
            ? `
          <form id="reviewForm" class="review-form">
            <label>Your rating
              <select id="reviewRating" required>
                <option value="">Select a rating</option>
                <option value="5">★★★★★ Excellent</option>
                <option value="4">★★★★☆ Good</option>
                <option value="3">★★★☆☆ Okay</option>
                <option value="2">★★☆☆☆ Poor</option>
                <option value="1">★☆☆☆☆ Terrible</option>
              </select>
            </label>
            <textarea id="reviewComment" placeholder="Share your thoughts on this product..." required></textarea>
            <button type="submit" class="secondary-btn">Submit review</button>
          </form>
        `
            : '<p class="muted">Log in to leave a review.</p>'
        }
      </div>
    </div>
  `;

  els.productModal.classList.remove('hidden');
  await loadReviews(product.id);
}

async function loadReviews(productId) {
  const container = document.getElementById('reviewsList');
  if (!container) return;

  try {
    const data = await apiFetch(`${API.product}/products/${productId}/reviews`);
    const reviews = data.items || [];

    if (!reviews.length) {
      container.innerHTML = '<p class="muted">No reviews yet — be the first!</p>';
      return;
    }

    container.innerHTML = reviews
      .map(
        (review) => `
          <div class="review-item">
            <div class="review-item-head">
              <span class="stars">${renderStars(review.rating)}</span>
              <span class="review-date">${new Date(review.createdAt).toLocaleDateString()}</span>
            </div>
            <p>${review.comment}</p>
          </div>
        `
      )
      .join('');
  } catch (error) {
    container.innerHTML = '<p class="muted">Could not load reviews right now.</p>';
  }
}

async function submitReview(productId, rating, comment) {
  try {
    await apiFetch(`${API.product}/products/${productId}/reviews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ rating: Number(rating), comment })
    });

    showToast('Review submitted, thank you!', 'success');

    // Refresh this product's rating everywhere it's shown — the catalog
    // grid, the featured strip, and this modal itself.
    const updated = await apiFetch(`${API.product}/products/${productId}`);
    const index = state.products.findIndex((item) => item.id === productId);
    if (index !== -1) state.products[index] = updated;

    applyFilters();
    await showProductModal(updated);
  } catch (error) {
    showToast(error.message || 'Unable to submit review', 'error');
  }
}

// Shopper-facing names for the order lifecycle (order-service orderStateMachine.ts).
// "paid" reads as "Confirmed" because, until online payment arrives, orders are
// confirmed without a card payment. "placed" is the pre-v2.8 spelling.
const STATUS_LABELS = {
  pending_payment: 'Awaiting payment',
  paid: 'Confirmed',
  placed: 'Confirmed',
  packed: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded'
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function apiFetch(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  // Not every response is JSON: the ingress answers rate-limited requests with
  // a small HTML page, and JSON.parse on that used to surface as a cryptic
  // "Unexpected token '<'" toast.
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401 && headers.Authorization && state.token) {
      handleSessionEnded();
      throw new Error('Please sign in again.');
    }
    if (response.status === 429 && !data?.message) {
      throw new Error('You are going a little fast. Please wait a moment and try again.');
    }
    throw new Error(data?.message || data?.error || 'Request failed');
  }

  return data;
}

function setCatalogLoading(isLoading) {
  if (!els.catalogGrid) return;

  if (isLoading) {
    els.catalogGrid.innerHTML = `
      <div class="loading-skeleton" style="grid-column: 1 / -1;">
        <div class="loading-card"></div>
        <div class="loading-card"></div>
        <div class="loading-card"></div>
        <div class="loading-card"></div>
      </div>
    `;
    return;
  }

  applyFilters();
}

async function loadProducts() {
  setCatalogLoading(true);
  const params = new URLSearchParams({ limit: '20', offset: '0' });
  const url = `${API.product}/products?${params.toString()}`;
  const data = await apiFetch(url);
  state.products = data.items || [];
  renderFeaturedProducts();
  renderCategoryTabs();
  applyFilters();
}

function renderCategoryTabs() {
  const categories = ['all', ...new Set(state.products.map((product) => product.category))];
  els.categoryTabs.innerHTML = categories
    .map((category) => {
      const label = category === 'all' ? 'All' : category.charAt(0).toUpperCase() + category.slice(1);
      const isActive = state.selectedCategory === category;
      return `<button class="${isActive ? 'active' : ''}" data-category="${category}">${label}</button>`;
    })
    .join('');

  els.categoryTabs.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCategory = button.dataset.category;
      renderCategoryTabs();
      applyFilters();
    });
  });
}

function renderFeaturedProducts() {
  if (!els.featuredGrid || !state.products.length) return;

  const featured = state.products.slice(0, 3);
  els.featuredGrid.innerHTML = featured
    .map(
      (product) => `
        <article class="feature-card reveal" style="background-image: url('${product.imageUrl}')">
          <span>Featured</span>
          <h3>${product.name}</h3>
          <p>${formatPrice(product.priceMinor)} · ${product.category}</p>
        </article>
      `
    )
    .join('');

  observeReveals();
}

function applyFilters() {
  const query = state.searchQuery.trim().toLowerCase();
  let visibleProducts = state.products.filter((product) => {
    const matchesCategory = state.selectedCategory === 'all' || product.category === state.selectedCategory;
    const matchesSearch = !query || [product.name, product.description, product.category].join(' ').toLowerCase().includes(query);
    return matchesCategory && matchesSearch;
  });

  if (state.sortMode === 'price-asc') {
    visibleProducts = [...visibleProducts].sort((a, b) => a.priceMinor - b.priceMinor);
  }

  if (state.sortMode === 'price-desc') {
    visibleProducts = [...visibleProducts].sort((a, b) => b.priceMinor - a.priceMinor);
  }

  state.filteredProducts = visibleProducts;

  if (els.catalogCount) {
    els.catalogCount.textContent = `${visibleProducts.length} item${visibleProducts.length === 1 ? '' : 's'}`;
  }

  if (!visibleProducts.length) {
    els.catalogGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; min-height: 220px;">
        <div>
          <h3>No products found</h3>
          <p>Try another keyword or switch category.</p>
        </div>
      </div>
    `;
    return;
  }

  els.catalogGrid.innerHTML = visibleProducts
    .map(
      (product) => `
        <article class="product-card reveal">
          <div class="product-media" style="background-image: url('${product.imageUrl}')">
            <span class="product-badge">${product.stock > 0 ? 'New' : 'Sold out'}</span>
            <button class="icon-btn wish-toggle${isWishlisted(product.id) ? ' active' : ''}" data-wishlist-toggle="${product.id}" aria-label="Save to wishlist" style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,0.85);">${isWishlisted(product.id) ? '♥' : '♡'}</button>
          </div>
          <div class="product-info">
            <h3>${product.name}</h3>
            ${renderRatingLine(product.rating)}
            <p>${product.description}</p>
            <div class="product-meta">
              <span class="product-price">${formatPrice(product.priceMinor)}</span>
              <div class="product-actions">
                <button class="icon-btn" data-product-detail="${product.id}" aria-label="View product details">⌕</button>
                <button class="small-btn" data-product-add="${product.id}">Add</button>
              </div>
            </div>
          </div>
        </article>
      `
    )
    .join('');

  // data-product-add is handled by the single delegated document click
  // listener in attachEvents() — do not also bind it here, or a click would
  // call addToCart twice (once from each listener) and double the quantity.
  els.catalogGrid.querySelectorAll('[data-product-detail]').forEach((button) => {
    button.addEventListener('click', () => {
      const product = state.products.find((item) => item.id === button.dataset.productDetail);
      if (product) showProductModal(product);
    });
  });

  observeReveals();
}

function getCartProductLookup() {
  return Object.fromEntries(state.products.map((product) => [product.id, product]));
}

function calculateCartTotals() {
  const map = getCartProductLookup();
  let subtotal = 0;

  state.cart.forEach((item) => {
    const product = map[item.productId];
    if (product) subtotal += product.priceMinor * item.quantity;
  });

  els.subtotalValue.textContent = formatPrice(subtotal);
  els.totalValue.textContent = formatPrice(subtotal);
  els.cartCount.textContent = state.cart.reduce((sum, item) => sum + item.quantity, 0).toString();
}

function renderCart() {
  const map = getCartProductLookup();

  if (!state.cart.length) {
    els.cartItems.innerHTML = `
      <div class="empty-state">
        <div>
          <h3>Your cart is empty</h3>
          <p>Add a few essentials and come back.</p>
        </div>
      </div>
    `;
    calculateCartTotals();
    return;
  }

  els.cartItems.innerHTML = state.cart
    .map((item) => {
      const product = map[item.productId];
      if (!product) return '';

      return `
        <div class="cart-item">
          <div class="cart-item-thumb" style="background-image: url('${product.imageUrl}')"></div>
          <div>
            <h4>${product.name}</h4>
            <p>${formatPrice(product.priceMinor)} each</p>
            <div class="cart-actions">
              <div class="qty-controls">
                <button data-cart-qty="decrease" data-product-id="${product.id}">−</button>
                <span>${item.quantity}</span>
                <button data-cart-qty="increase" data-product-id="${product.id}">+</button>
              </div>
              <strong>${formatPrice(product.priceMinor * item.quantity)}</strong>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  els.cartItems.querySelectorAll('[data-cart-qty]').forEach((button) => {
    button.addEventListener('click', async () => {
      const productId = button.dataset.productId;
      const direction = button.dataset.cartQty;
      const existing = state.cart.find((item) => item.productId === productId);
      if (!existing) return;

      const nextQuantity = direction === 'increase' ? existing.quantity + 1 : existing.quantity - 1;
      if (nextQuantity <= 0) {
        state.cart = state.cart.filter((item) => item.productId !== productId);
      } else {
        existing.quantity = nextQuantity;
      }

      if (state.token) {
        await syncCartToBackend();
      }
      renderCart();
    });
  });

  calculateCartTotals();
}

function isWishlisted(productId) {
  return state.wishlist.some((item) => item.productId === productId);
}

function updateWishlistToggles() {
  document.querySelectorAll('[data-wishlist-toggle]').forEach((button) => {
    const wishlisted = isWishlisted(button.dataset.wishlistToggle);
    button.classList.toggle('active', wishlisted);
    button.textContent = wishlisted ? '♥' : '♡';
  });
  if (els.wishlistCount) els.wishlistCount.textContent = state.wishlist.length.toString();
}

function renderWishlist() {
  if (!els.wishlistItems) return;

  if (!state.wishlist.length) {
    els.wishlistItems.innerHTML = `
      <div class="empty-state">
        <div>
          <h3>Your wishlist is empty</h3>
          <p>Tap the heart on any product to save it here.</p>
        </div>
      </div>
    `;
    if (els.wishlistCount) els.wishlistCount.textContent = '0';
    return;
  }

  const map = getCartProductLookup();

  els.wishlistItems.innerHTML = state.wishlist
    .map((item) => {
      const product = map[item.productId];
      if (!product) return '';

      return `
        <div class="cart-item">
          <div class="cart-item-thumb" style="background-image: url('${product.imageUrl}')"></div>
          <div>
            <h4>${product.name}</h4>
            <p>${formatPrice(product.priceMinor)}</p>
            <div class="cart-actions">
              <button class="small-btn" data-product-add="${product.id}">Add to cart</button>
              <button class="icon-btn" data-wishlist-remove="${product.id}" aria-label="Remove from wishlist">✕</button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  if (els.wishlistCount) els.wishlistCount.textContent = state.wishlist.length.toString();
}

async function loadWishlist() {
  if (!state.token) {
    state.wishlist = [];
    renderWishlist();
    updateWishlistToggles();
    return;
  }

  try {
    const data = await apiFetch(`${API.user}/wishlist`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    state.wishlist = data.items || [];
  } catch (error) {
    console.warn('Could not load wishlist', error);
    state.wishlist = [];
  }

  renderWishlist();
  updateWishlistToggles();
}

async function toggleWishlist(productId) {
  if (!state.token) {
    showAuthModal();
    showToast('Please log in to save items', 'error');
    return;
  }

  try {
    const wishlisted = isWishlisted(productId);
    const data = wishlisted
      ? await apiFetch(`${API.user}/wishlist/${productId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${state.token}` }
        })
      : await apiFetch(`${API.user}/wishlist`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.token}` },
          body: JSON.stringify({ productId })
        });

    state.wishlist = data.items || [];
    renderWishlist();
    updateWishlistToggles();
    showToast(wishlisted ? 'Removed from wishlist' : 'Saved to wishlist', 'success');
  } catch (error) {
    showToast(error.message || 'Unable to update wishlist', 'error');
  }
}

function renderCouponChips() {
  if (!els.couponChips) return;

  if (!state.availableCoupons.length) {
    els.couponChips.innerHTML = '';
    return;
  }

  els.couponChips.innerHTML = state.availableCoupons
    .map((coupon) => {
      const label = coupon.type === 'percent' ? `${coupon.value}% off` : `${formatPrice(coupon.value)} off`;
      return `<button type="button" class="coupon-chip" data-coupon-code="${coupon.code}">${coupon.code} · ${label}</button>`;
    })
    .join('');
}

async function loadCoupons() {
  if (!state.token) {
    state.availableCoupons = [];
    renderCouponChips();
    return;
  }

  try {
    const data = await apiFetch(`${API.order}/coupons`, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    state.availableCoupons = data.items || [];
  } catch (error) {
    console.warn('Could not load coupons', error);
    state.availableCoupons = [];
  }

  renderCouponChips();
}

async function cancelOrder(orderId) {
  if (!confirm('Cancel this order?')) return;

  try {
    await apiFetch(`${API.order}/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    showToast('Order cancelled', 'success');
    await loadOrders();
  } catch (error) {
    showToast(error.message || 'Unable to cancel order', 'error');
  }
}

function updateAuthState() {
  const loggedIn = Boolean(state.token && state.user);
  els.authButton.textContent = loggedIn ? 'Profile' : 'Login';
  els.logoutButton.classList.toggle('hidden', !loggedIn);
  els.profileName.textContent = loggedIn ? state.user.displayName || state.user.email : 'Guest user';
  els.profileEmail.textContent = loggedIn ? state.user.email : 'Not signed in';
}

async function syncCartToBackend() {
  if (!state.token) return;

  try {
    await apiFetch(`${API.order}/cart`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${state.token}` }
    });
  } catch (error) {
    console.warn('Cart sync skipped', error);
  }
}

async function addToCart(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) return;

  if (!state.token) {
    showAuthModal();
    showToast('Please log in to add items to your cart', 'error');
    return;
  }

  try {
    const body = { productId, quantity: 1 };
    await apiFetch(`${API.order}/cart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: JSON.stringify(body)
    });

    const existing = state.cart.find((item) => item.productId === productId);
    if (existing) {
      existing.quantity += 1;
    } else {
      state.cart.push({ productId, quantity: 1 });
    }
    renderCart();
    toggleCart(true);
    showToast(`${product.name} added to cart`, 'success');
  } catch (error) {
    showToast(error.message || 'Unable to add item to cart', 'error');
  }
}

// One random key per checkout ATTEMPT (see order-service idempotencyStore.ts).
// It is reused when the same attempt is retried -- a double-click, or "Place
// order" again after a network error -- so the server returns the order it
// already created instead of making a second one. It is dropped after success,
// and whenever the cart or coupon changes, because that is a NEW attempt.
let checkoutAttempt = null; // { key, fingerprint }
let checkoutInFlight = false;

function newIdempotencyKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  // randomUUID needs a secure context (https or localhost); getRandomValues does not.
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function checkoutKeyFor(couponCode) {
  const fingerprint = JSON.stringify({ cart: state.cart, couponCode: couponCode || '' });
  if (!checkoutAttempt || checkoutAttempt.fingerprint !== fingerprint) {
    checkoutAttempt = { key: newIdempotencyKey(), fingerprint };
  }
  return checkoutAttempt.key;
}

async function checkout() {
  if (!state.token) {
    showAuthModal();
    showToast('Login to complete your checkout', 'error');
    return;
  }
  // The server is the real guard; this just stops an obvious double-click.
  if (checkoutInFlight) return;
  checkoutInFlight = true;
  if (els.checkoutButton) els.checkoutButton.disabled = true;

  try {
    const couponCode = els.couponInput?.value.trim();
    const order = await apiFetch(`${API.order}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Idempotency-Key': checkoutKeyFor(couponCode)
      },
      body: JSON.stringify(couponCode ? { couponCode } : {})
    });

    checkoutAttempt = null;
    state.cart = [];
    renderCart();
    toggleCart(false);
    if (els.couponInput) els.couponInput.value = '';
    await loadOrders();
    setPage('orders');

    const savedNote = order.discountMinor > 0 ? ` — you saved ${formatPrice(order.discountMinor)}!` : '';
    showToast(`Order placed successfully${savedNote}`, 'success');
  } catch (error) {
    showToast(error.message || 'Checkout failed', 'error');
  } finally {
    checkoutInFlight = false;
    if (els.checkoutButton) els.checkoutButton.disabled = false;
  }
}

async function loadOrders() {
  if (!state.token) {
    els.ordersList.innerHTML = `
      <div class="empty-state">
        <div>
          <h3>Sign in to view your orders</h3>
          <p>Your recent purchases will appear here.</p>
        </div>
      </div>
    `;
    return;
  }

  try {
    const data = await apiFetch(`${API.order}/orders`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${state.token}` }
    });

    state.orders = data.items || [];

    if (!state.orders.length) {
      els.ordersList.innerHTML = `
        <div class="empty-state">
          <div>
            <h3>No orders yet</h3>
            <p>Your orders will appear after checkout.</p>
          </div>
        </div>
      `;
      return;
    }

    els.ordersList.innerHTML = state.orders
      .map((order) => {
        const discountRows =
          order.discountMinor > 0
            ? `
              <div class="order-row"><span>Subtotal</span><strong>${formatPrice(order.subtotalMinor)}</strong></div>
              <div class="order-row"><span>Discount (${order.couponCode})</span><strong>−${formatPrice(order.discountMinor)}</strong></div>
            `
            : '';

        // The server's state machine is the real rule; this only hides a button
        // that would be refused. Customers may cancel until the order is packed.
        const cancellable = ['pending_payment', 'paid', 'placed'].includes(order.status);
        const cancelButton = cancellable
          ? `<button class="secondary-btn wide" data-order-cancel="${order.id}">Cancel order</button>`
          : '';
        const timeline = (order.history || [])
          .map(
            (change) => `
              <li>
                <span>${escapeHtml(statusLabel(change.to))}</span>
                <time datetime="${change.at}">${new Date(change.at).toLocaleString()}</time>
              </li>`
          )
          .join('');

        return `
          <article class="order-card">
            <h3>Order #${order.id.slice(0, 8)}</h3>
            <div class="order-row"><span>Status</span><strong class="status-${order.status}">${escapeHtml(statusLabel(order.status))}</strong></div>
            ${discountRows}
            <div class="order-row"><span>Total</span><strong>${formatPrice(order.totalMinor)}</strong></div>
            <div class="order-row"><span>Items</span><strong>${order.lines.reduce((sum, line) => sum + line.quantity, 0)}</strong></div>
            <div class="order-row"><span>Placed</span><strong>${new Date(order.createdAt).toLocaleDateString()}</strong></div>
            ${timeline ? `<ol class="order-timeline" aria-label="Order history">${timeline}</ol>` : ''}
            ${cancelButton}
          </article>
        `;
      })
      .join('');
  } catch (error) {
    console.error(error);
    els.ordersList.innerHTML = `
      <div class="empty-state">
        <div>
          <h3>Could not load orders</h3>
          <p>Please try again in a moment.</p>
        </div>
      </div>
    `;
  }
}

async function authSubmit(event) {
  event.preventDefault();

  const email = els.emailInput.value.trim();
  const password = els.passwordInput.value.trim();
  const displayName = els.displayNameInput.value.trim();

  if (!email || !password || (state.authMode === 'register' && !displayName)) {
    alert('Please complete the required fields.');
    return;
  }

  try {
    if (state.authMode === 'register') {
      await apiFetch(`${API.user}/register`, {
        method: 'POST',
        body: JSON.stringify({ email, password, displayName })
      });
      showToast('Account created successfully', 'success');
    }

    const loginResult = await apiFetch(`${API.user}/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });

    state.token = loginResult.token;
    state.user = loginResult.user;

    localStorage.setItem('aetherToken', state.token);
    localStorage.setItem('aetherUser', JSON.stringify(state.user));

    hideAuthModal();
    authFormReset();
    updateAuthState();
    await loadOrders();
    await loadWishlist();
    await loadCoupons();
    setPage('profile');
    showToast('Welcome back!', 'success');

    try {
      const cartData = await apiFetch(`${API.order}/cart`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${state.token}` }
      });
      state.cart = cartData.items || [];
      renderCart();
    } catch (error) {
      console.warn('No cart yet', error);
      state.cart = [];
      renderCart();
    }
  } catch (error) {
    showToast(error.message || 'Authentication failed.', 'error');
  }
}

function authFormReset() {
  els.authForm.reset();
  els.displayNameInput.value = '';
}

function logout({ silent = false } = {}) {
  state.token = '';
  state.user = null;
  state.cart = [];
  state.wishlist = [];
  state.availableCoupons = [];
  localStorage.removeItem('aetherToken');
  localStorage.removeItem('aetherUser');
  updateAuthState();
  renderCart();
  renderWishlist();
  updateWishlistToggles();
  renderCouponChips();
  loadOrders();
  setPage('home');
  if (!silent) showToast('Logged out', 'success');
}

// A 401 on a request that carried our token means the session is over: the
// token expired (1h) or the signing key was rotated. Previously the page kept
// looking signed in while every cart/order/wishlist call failed with "Invalid
// or expired token". Now the stale session is cleared and the shopper is asked
// to sign in again -- once, even if several requests fail at the same moment.
let sessionEndHandled = false;
function handleSessionEnded() {
  if (sessionEndHandled || !state.token) return;
  sessionEndHandled = true;
  logout({ silent: true });
  showToast('Your session has ended. Please sign in again.', 'error');
  showAuthModal();
  setTimeout(() => { sessionEndHandled = false; }, 2000);
}

function attachEvents() {
  document.querySelectorAll('[data-page-target]').forEach((button) => {
    button.addEventListener('click', () => {
      setPage(button.dataset.pageTarget);
      if (button.dataset.pageTarget === 'catalog') {
        applyFilters();
      }
      if (button.dataset.pageTarget === 'releases') {
        observeReveals();
      }
    });
  });

  els.themeToggle?.addEventListener('click', toggleTheme);

  document.querySelectorAll('.mobile-nav-link[data-page-target]').forEach((button) => {
    button.addEventListener('click', () => {
      setPage(button.dataset.pageTarget);
      toggleMobileNav(false);
    });
  });

  els.mobileWishlistLink?.addEventListener('click', () => {
    toggleMobileNav(false);
    toggleWishlistDrawer(true);
  });

  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
  });

  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.closeModal;
      const modal = document.getElementById(target);
      if (modal) modal.classList.add('hidden');
    });
  });

  els.navToggle?.addEventListener('click', () => {
    const nextState = !els.mobileMenu.classList.contains('open');
    toggleMobileNav(nextState);
  });

  els.closeMobileMenuButton?.addEventListener('click', () => toggleMobileNav(false));

  els.authButton.addEventListener('click', () => {
    if (state.token) {
      setPage('profile');
      return;
    }
    showAuthModal();
  });

  els.cartButton.addEventListener('click', () => toggleCart(true));
  els.closeCartButton.addEventListener('click', () => toggleCart(false));
  els.wishlistButton?.addEventListener('click', () => toggleWishlistDrawer(true));
  els.closeWishlistButton?.addEventListener('click', () => toggleWishlistDrawer(false));
  els.cartBackdrop.addEventListener('click', () => {
    toggleCart(false);
    toggleWishlistDrawer(false);
    toggleMobileNav(false);
  });
  els.checkoutButton.addEventListener('click', checkout);
  els.authForm.addEventListener('submit', authSubmit);
  els.searchInput.addEventListener('input', (event) => {
    state.searchQuery = event.target.value;
    applyFilters();
  });

  els.sortSelect?.addEventListener('change', (event) => {
    state.sortMode = event.target.value;
    applyFilters();
  });

  els.logoutButton.addEventListener('click', logout);

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-product-add]');
    if (button) {
      addToCart(button.dataset.productAdd);
    }

    const wishToggle = event.target.closest('[data-wishlist-toggle]');
    if (wishToggle) {
      toggleWishlist(wishToggle.dataset.wishlistToggle);
    }

    const wishRemove = event.target.closest('[data-wishlist-remove]');
    if (wishRemove) {
      toggleWishlist(wishRemove.dataset.wishlistRemove);
    }

    const couponChip = event.target.closest('[data-coupon-code]');
    if (couponChip && els.couponInput) {
      els.couponInput.value = couponChip.dataset.couponCode;
    }

    const cancelButton = event.target.closest('[data-order-cancel]');
    if (cancelButton) {
      cancelOrder(cancelButton.dataset.orderCancel);
    }

    const modalButton = event.target.closest('[data-close-modal]');
    if (modalButton) {
      document.getElementById(modalButton.dataset.closeModal)?.classList.add('hidden');
    }
  });

  // The review form is re-created every time a product modal opens, so it is
  // handled via delegation instead of a direct listener that would go stale.
  document.addEventListener('submit', (event) => {
    if (event.target.id !== 'reviewForm') return;
    event.preventDefault();

    if (!state.token) {
      showAuthModal();
      return;
    }

    const rating = document.getElementById('reviewRating')?.value;
    const comment = document.getElementById('reviewComment')?.value.trim();

    if (!rating || !comment) {
      showToast('Please add a rating and a comment', 'error');
      return;
    }

    submitReview(state.currentProductId, rating, comment);
  });

  document.querySelectorAll('.category-card').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCategory = button.dataset.category;
      renderCategoryTabs();
      applyFilters();
      setPage('catalog');
    });
  });
}

async function init() {
  applyTheme(localStorage.getItem('aetherTheme') || 'light');
  attachEvents();
  updateAuthState();
  renderCart();
  renderFeaturedProducts();
  renderReleaseNotes();
  await loadProducts();
  await loadOrders();
  await loadWishlist();
  await loadCoupons();
  setPage('home');
  observeReveals();
}

init();
