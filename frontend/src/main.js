import "./style.css";
import { api, imageUrl } from "./api.js";
import * as auth from "./auth.js";

const STEPS = [
  { status: "ORDERED", label: "Order placed" },
  { status: "PACKED", label: "Packed by the shop" },
  { status: "SHIPPED", label: "Shipped" },
];
const MAX_QTY = 10;
const POLL_MS = 5000; // the shop packs and ships by hand (back office): check every 5 s for 10 min
const POLL_TIMES = 120;

const CART_KEY = "fisa-shop-cart"; // survives the round trip to the hosted sign-in page
const loadCart = () => {
  try {
    return JSON.parse(sessionStorage.getItem(CART_KEY)) ?? {};
  } catch {
    return {};
  }
};
const state = { products: [], cart: loadCart(), genre: "All", query: "", user: null };
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
  saveCart();
  renderCart();
  renderCatalog();
}

function saveCart() {
  try {
    sessionStorage.setItem(CART_KEY, JSON.stringify(state.cart));
  } catch {} // private mode: the crate just won't survive a sign-in redirect
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

const VIEWS = { cart: "cartView", track: "trackView", orders: "ordersView" };
const TITLES = { cart: "Your crate", track: "Your crate", orders: "My orders" };
function showView(view) {
  for (const [name, id] of Object.entries(VIEWS)) $(id).hidden = name !== view;
  $("drawerTitle").textContent = TITLES[view];
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
    saveCart();
    await loadProducts(); // stock changed
    $("confirmMsg").textContent = res.message;
    showView("track");
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

// --- Account + my orders --------------------------------------------------------
function renderAccount() {
  const user = state.user;
  const button = $("account");
  button.hidden = !auth.enabled();
  button.textContent = user ? "My orders" : "Sign in";
  let menu = $("signOut");
  if (user && !menu) {
    menu = document.createElement("button");
    menu.id = "signOut";
    menu.type = "button";
    menu.className = "account-btn";
    menu.textContent = "Sign out";
    menu.title = user.email;
    menu.addEventListener("click", () => {
      auth.signOut();
      state.user = null;
      renderAccount();
      openCrate(false);
    });
    button.after(menu);
  }
  if (!user && menu) menu.remove();

  $("guestHint").hidden = !!user || !auth.enabled();
  $("email").readOnly = !!user; // order emails go to the account's address
  if (user) {
    $("email").value = user.email;
    if ($("name").value === "Demo Customer") $("name").value = user.email.split("@")[0];
  }
}

// --- Sign in / up page (#/signin, #/signup, #/forgot) -----------------------------
// mode: signin | signup | confirm (emailed code after signing up) | forgot | reset
const AUTH_MODES = {
  signin: { title: "Sign in", lede: "Follow your orders and cancel them while they are not packed yet.", submit: "Sign in" },
  signup: { title: "Create your account", lede: "It only takes an email and a password.", submit: "Create account" },
  confirm: { title: "Check your inbox", lede: "We emailed you a code to confirm your address.", submit: "Confirm and sign in" },
  forgot: { title: "Reset your password", lede: "We will email you a code to choose a new one.", submit: "Send the code" },
  reset: { title: "Choose a new password", lede: "Enter the code we emailed you.", submit: "Save and sign in" },
};
let authMode = null; // nothing rendered yet
let pendingPassword = ""; // kept in memory between sign-up and confirmation, to sign in right after

function setAuthMessage(kind, text) {
  $("authError").hidden = kind !== "error" || !text;
  $("authInfo").hidden = kind !== "info" || !text;
  (kind === "error" ? $("authError") : $("authInfo")).textContent = text ?? "";
}

function renderAuth(mode, info) {
  authMode = mode;
  const m = AUTH_MODES[mode];
  const codeStep = mode === "confirm" || mode === "reset";
  $("authTitle").textContent = m.title;
  $("authLede").textContent = m.lede;
  $("authSubmit").textContent = m.submit;
  $("codeRow").hidden = !codeStep;
  $("authCode").required = codeStep;
  $("passwordRow").hidden = mode === "forgot" || mode === "confirm";
  $("authPassword").required = !$("passwordRow").hidden;
  $("authPassword").autocomplete = mode === "signin" ? "current-password" : "new-password";
  $("passwordHint").hidden = mode !== "signup" && mode !== "reset";
  $("authEmail").readOnly = codeStep;
  $("linkForgot").hidden = mode !== "signin";
  $("linkResend").hidden = mode !== "confirm";
  $("switchText").textContent = mode === "signup" ? "Already have an account?" : mode === "signin" ? "New here?" : "";
  $("switchLink").textContent = mode === "signup" ? "Sign in" : mode === "signin" ? "Create an account" : "Back to sign in";
  $("switchLink").href = mode === "signin" ? "#/signup" : "#/signin";
  setAuthMessage(info ? "info" : "error", info);
  $("authCode").value = "";
  (codeStep ? $("authCode") : $("authEmail").value ? $("authPassword") : $("authEmail")).focus();
}

function route() {
  const page = location.hash.match(/^#\/(signin|signup|forgot)$/)?.[1];
  $("authPage").hidden = !page || !auth.enabled();
  document.body.classList.toggle("auth-open", !$("authPage").hidden);
  if (!$("authPage").hidden && page !== authMode && !(authMode === "confirm" && page === "signup") && !(authMode === "reset" && page === "forgot")) {
    renderAuth(page);
  }
}

async function finishSignIn(email, password) {
  state.user = await auth.signIn(email, password);
  pendingPassword = "";
  renderAccount();
  location.hash = "";
  showOrders();
}

async function submitAuth(event) {
  event.preventDefault();
  const email = $("authEmail").value.trim().toLowerCase();
  const password = $("authPassword").value;
  const code = $("authCode").value;
  if (!email.includes("@")) return setAuthMessage("error", "Enter a valid email address.");
  if (!$("passwordRow").hidden && !password) return setAuthMessage("error", "Enter your password.");
  if (!$("codeRow").hidden && !code.trim()) return setAuthMessage("error", "Enter the code from the email.");
  setAuthMessage();
  $("authSubmit").disabled = true;
  try {
    if (authMode === "signin") {
      try {
        await finishSignIn(email, password);
      } catch (e) {
        if (e.code !== "UserNotConfirmedException") throw e;
        pendingPassword = password;
        await auth.resendCode(email);
        renderAuth("confirm", "Your address is not confirmed yet. We sent you a new code.");
      }
    } else if (authMode === "signup") {
      await auth.signUp(email, password);
      pendingPassword = password;
      renderAuth("confirm", `We sent a code to ${email}.`);
    } else if (authMode === "confirm") {
      await auth.confirmSignUp(email, code);
      if (!pendingPassword) return renderAuth("signin", "Email confirmed. You can sign in now.");
      await finishSignIn(email, pendingPassword);
    } else if (authMode === "forgot") {
      await auth.forgotPassword(email);
      renderAuth("reset", `We sent a code to ${email}.`);
    } else if (authMode === "reset") {
      await auth.resetPassword(email, code, password);
      await finishSignIn(email, password);
    }
  } catch (e) {
    setAuthMessage("error", e.message);
  } finally {
    $("authSubmit").disabled = false;
  }
}

function orderCard(o) {
  const date = new Date(o.created_at).toLocaleString();
  const lines = o.items.map((i) => `<li>${escapeHtml(i.quantity)} × ${escapeHtml(i.name)}</li>`).join("");
  const action =
    o.status === "ORDERED"
      ? `<button type="button" class="cancel-btn" data-cancel="${escapeHtml(o.order_id)}">Cancel order</button>`
      : o.status === "PACKED"
        ? `<span class="muted">Already packed, it can no longer be cancelled.</span>`
        : o.status === "SHIPPED" && o.tracking_number
          ? `<span class="muted">Tracking number: ${escapeHtml(o.tracking_number)}</span>`
          : "";
  return `
    <article class="order">
      <div class="order-head"><strong>#${escapeHtml(o.order_id.slice(0, 8))}</strong><span class="status ${escapeHtml(o.status)}">${escapeHtml(o.status.toLowerCase())}</span></div>
      <span class="muted">${escapeHtml(date)} · ${euros(o.total)}</span>
      <ul>${lines}</ul>
      ${action}
    </article>`;
}

async function showOrders() {
  showView("orders");
  openCrate(true);
  $("ordersError").hidden = true;
  try {
    const orders = await api("/me/orders");
    $("orders").innerHTML = orders.length ? orders.map(orderCard).join("") : `<p class="muted empty">No orders yet. Go dig!</p>`;
  } catch (e) {
    $("ordersError").textContent = e.message;
    $("ordersError").hidden = false;
    if (!auth.token()) {
      state.user = null;
      renderAccount();
    }
  }
}

async function cancelOrder(orderId) {
  if (!confirm("Cancel this order? The records go back in stock.")) return;
  $("ordersError").hidden = true;
  try {
    await api(`/me/orders/${orderId}/cancel`, { method: "POST" });
    await loadProducts(); // stock is back
  } catch (e) {
    $("ordersError").textContent = /cannot move/.test(e.message) ? "Too late: the shop already packed this order." : e.message;
    $("ordersError").hidden = false;
  }
  const orders = await api("/me/orders").catch(() => null);
  if (orders) $("orders").innerHTML = orders.map(orderCard).join("");
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
$("account").addEventListener("click", () => (state.user ? showOrders() : (location.hash = "#/signin")));
$("authForm").addEventListener("submit", submitAuth);
$("authBack").addEventListener("click", (e) => {
  e.preventDefault();
  history.replaceState(null, "", location.pathname);
  route();
});
$("linkResend").addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    await auth.resendCode($("authEmail").value);
    setAuthMessage("info", "A new code is on its way.");
  } catch (err) {
    setAuthMessage("error", err.message);
  }
});
window.addEventListener("hashchange", route);
$("orders").addEventListener("click", (e) => {
  const id = e.target.closest("[data-cancel]")?.dataset.cancel;
  if (id) cancelOrder(id);
});
$("backToCrate").addEventListener("click", () => showView("cart"));
$("keepShopping").addEventListener("click", () => {
  showView("cart");
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

auth
  .init()
  .then((session) => {
    state.user = session;
  })
  .catch((e) => console.warn(e.message))
  .finally(() => {
    renderAccount();
    route(); // deep link to #/signin
  });

loadProducts().catch((e) => ($("catalog").innerHTML = `<p class="error">Could not load the catalog: ${escapeHtml(e.message)}</p>`));
