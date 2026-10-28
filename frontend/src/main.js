import "./style.css";
import { api, imageUrl } from "./api.js";

const STEPS = [
  { status: "ORDERED", label: "Order placed" },
  { status: "PACKED", label: "Packed by the shop" },
  { status: "SHIPPED", label: "Shipped" },
];
const MAX_QTY = 10;
const POLL_MS = 5000; // the shop packs and ships by hand (back office): check every 5 s for 10 min
const POLL_TIMES = 120;

const state = { products: [], cart: {}, genre: "All", query: "" };
const $ = (id) => document.getElementById(id);

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const euros = (n) => `${Number(n).toFixed(2)} €`;
const productById = (id) => state.products.find((p) => p.id === id);
const maxQty = (p) => Math.min(MAX_QTY, p?.stock ?? 0);

// --- Catalog ----------------------------------------------------------------
function renderGenres() {
  const genres = ["All", ...new Set(state.products.map((p) => p.genre).filter(Boolean))];
  $("genres").innerHTML = genres
    .map((g) => `<button type="button" class="chip${g === state.genre ? " active" : ""}" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`)
    .join("");
}

function renderCatalog() {
  const q = state.query.trim().toLowerCase();
  const visible = state.products.filter(
    (p) =>
      (state.genre === "All" || p.genre === state.genre) &&
      (!q || [p.name, p.artist, p.genre].some((v) => String(v ?? "").toLowerCase().includes(q))),
  );
  $("catalog").innerHTML = visible.length
    ? visible.map(card).join("")
    : `<p class="muted">Nothing in this crate. Try another genre or search.</p>`;
}

function card(p) {
  const inCrate = state.cart[p.id] || 0;
  return `
    <article class="card">
      <div class="sleeve">
        <div class="disc" aria-hidden="true"></div>
        ${p.image
          ? `<img src="${escapeHtml(imageUrl(p.image))}" alt="${escapeHtml(p.name)} cover" loading="lazy">`
          : `<div class="no-cover">${escapeHtml(p.name)}</div>`}
      </div>
      <div class="card-body">
        <p class="meta">${escapeHtml(p.genre || "")}${p.year ? ` · ${escapeHtml(p.year)}` : ""}</p>
        <h3>${escapeHtml(p.name)}</h3>
        <p class="artist">${escapeHtml(p.artist || "")}</p>
        <p class="desc">${escapeHtml(p.description)}</p>
        <div class="buy">
          <span class="price">${euros(p.price)}</span>
          <button type="button" class="add" data-add="${escapeHtml(p.id)}" ${inCrate >= maxQty(p) ? "disabled" : ""}>
            ${inCrate ? `In crate · ${inCrate}` : p.stock > 0 ? "Add to crate" : "Sold out"}
          </button>
        </div>
        <p class="stock">${p.stock > 0 ? `${escapeHtml(p.stock)} in stock` : "Out of stock"}</p>
      </div>
    </article>`;
}

// --- Crate (cart) -------------------------------------------------------------
function setQty(id, qty) {
  state.cart[id] = Math.max(0, Math.min(maxQty(productById(id)), qty));
  if (!state.cart[id]) delete state.cart[id];
  renderCart();
  renderCatalog();
}

function renderCart() {
  const lines = Object.entries(state.cart);
  let total = 0;
  let count = 0;
  $("cartLines").innerHTML = lines.length
    ? lines
        .map(([id, qty]) => {
          const p = productById(id);
          total += p.price * qty;
          count += qty;
          return `
            <div class="line">
              <img src="${escapeHtml(imageUrl(p.image))}" alt="">
              <div>
                <strong>${escapeHtml(p.name)}</strong>
                <span class="muted">${escapeHtml(p.artist || "")}</span>
                <div class="stepper">
                  <button type="button" data-dec="${escapeHtml(id)}" aria-label="One less">−</button>
                  <span>${qty}</span>
                  <button type="button" data-inc="${escapeHtml(id)}" aria-label="One more" ${qty >= maxQty(p) ? "disabled" : ""}>+</button>
                </div>
              </div>
              <span class="line-price">${euros(p.price * qty)}</span>
            </div>`;
        })
        .join("")
    : `<p class="muted empty">Your crate is empty. Go dig!</p>`;
  $("total").textContent = euros(total);
  $("crateCount").textContent = count;
  $("placeOrder").disabled = !lines.length;
}

function openCrate(open) {
  $("crate").classList.toggle("open", open);
  $("crate").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
}

// --- Checkout + tracking ------------------------------------------------------
function renderStatus(order) {
  if (order.status === "CANCELLED") {
    $("timeline").innerHTML = `<li class="current">Cancelled by the shop</li>`;
    $("orderJson").textContent = JSON.stringify(order, null, 2);
    return;
  }
  const last = STEPS.length - 1;
  const found = STEPS.findIndex((s) => s.status === order.status);
  const idx = found === last ? last + 1 : found; // the final step is "done", not "in progress"
  $("timeline").innerHTML = STEPS.map(
    (s, i) => `<li class="${i < idx ? "done" : i === idx ? "current" : ""}">${escapeHtml(s.label)}</li>`,
  ).join("");
  $("orderJson").textContent = JSON.stringify(order, null, 2);
}

async function poll(orderId) {
  for (let i = 0; i < POLL_TIMES; i++) {
    const order = await api("/orders/" + orderId);
    renderStatus(order);
    if (order.status === "SHIPPED" || order.status === "CANCELLED") return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function placeOrder(event) {
  event.preventDefault();
  const button = $("placeOrder");
  button.disabled = true;
  $("checkoutError").hidden = true;
  try {
    const res = await api("/orders", {
      method: "POST",
      body: JSON.stringify({
        customer_name: $("name").value,
        customer_email: $("email").value,
        items: Object.entries(state.cart).map(([product_id, quantity]) => ({ product_id, quantity })),
      }),
    });
    state.cart = {};
    await loadProducts(); // stock changed
    $("confirmMsg").textContent = res.message;
    $("cartView").hidden = true;
    $("trackView").hidden = false;
    renderStatus(res);
    poll(res.order_id).catch((e) => ($("confirmMsg").textContent += ` (tracking stopped: ${e.message})`));
  } catch (e) {
    $("checkoutError").textContent = "Order failed: " + e.message;
    $("checkoutError").hidden = false;
    loadProducts().catch(() => {}); // e.g. sold out meanwhile: show the current stock
  } finally {
    button.disabled = !Object.keys(state.cart).length;
  }
}

// --- Wiring -------------------------------------------------------------------
$("genres").addEventListener("click", (e) => {
  const genre = e.target.closest("[data-genre]")?.dataset.genre;
  if (!genre) return;
  state.genre = genre;
  renderGenres();
  renderCatalog();
});
$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderCatalog();
});
$("catalog").addEventListener("click", (e) => {
  const id = e.target.closest("[data-add]")?.dataset.add;
  if (id) setQty(id, (state.cart[id] || 0) + 1);
});
$("cartLines").addEventListener("click", (e) => {
  const inc = e.target.closest("[data-inc]")?.dataset.inc;
  const dec = e.target.closest("[data-dec]")?.dataset.dec;
  if (inc) setQty(inc, state.cart[inc] + 1);
  if (dec) setQty(dec, state.cart[dec] - 1);
});
$("openCrate").addEventListener("click", () => openCrate(true));
$("closeCrate").addEventListener("click", () => openCrate(false));
$("scrim").addEventListener("click", () => openCrate(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && openCrate(false));
$("checkout").addEventListener("submit", placeOrder);
$("keepShopping").addEventListener("click", () => {
  $("trackView").hidden = true;
  $("cartView").hidden = false;
  openCrate(false);
});

api("/health")
  .then((h) => ($("backend").textContent = `backend: ${h.backend} · ${h.instance || ""} ${h.az || ""}`))
  .catch(() => ($("backend").textContent = "backend: unreachable"));

async function loadProducts() {
  state.products = await api("/products");
  // drop crate lines that are no longer available in that quantity
  for (const [id, qty] of Object.entries(state.cart)) {
    const max = maxQty(productById(id));
    if (qty > max) max ? (state.cart[id] = max) : delete state.cart[id];
  }
  renderGenres();
  renderCatalog();
  renderCart();
}

loadProducts().catch((e) => ($("catalog").innerHTML = `<p class="error">Could not load the catalog: ${escapeHtml(e.message)}</p>`));
