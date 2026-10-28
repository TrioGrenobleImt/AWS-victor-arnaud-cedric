import "./style.css";
import { api, imageUrl, uploadImage } from "./api.js";
import { logout, session } from "./auth.js";
import { columnChart } from "./chart.js";

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const dialog = $("#dialog");

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const euros = (n) => new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(n);
const dateTime = (iso) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

const STATUS = {
  ORDERED: { label: "Ordered", tone: "info" },
  PACKED: { label: "Packed", tone: "warning" },
  SHIPPED: { label: "Shipped", tone: "good" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
};
const badge = (status) => `<span class="badge ${STATUS[status]?.tone ?? ""}">${esc(STATUS[status]?.label ?? status)}</span>`;

function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3500);
}

const state = { month: thisMonth(), orderFilter: "ORDERED" };

// --- Dashboard ----------------------------------------------------------------
async function dashboard() {
  const d = await api(`/dashboard?month=${state.month}`);
  const max = thisMonth();
  view.innerHTML = `
    <div class="page-head">
      <h1>Sales · ${esc(monthName(d.month))}</h1>
      <label class="month">Month <input type="month" id="month" value="${esc(d.month)}" max="${max}"></label>
    </div>
    <section class="tiles">
      <div class="tile hero"><span class="label">Revenue</span><span class="value">${euros(d.revenue)}</span>
        <span class="sub">${d.orders} order${d.orders === 1 ? "" : "s"}, cancelled excluded</span></div>
      <div class="tile"><span class="label">Orders</span><span class="value">${d.orders}</span></div>
      <div class="tile"><span class="label">Records sold</span><span class="value">${d.items_sold}</span></div>
      <div class="tile"><span class="label">Average order</span><span class="value">${euros(d.average_order)}</span></div>
    </section>
    <section class="pipeline" aria-label="Orders by status">
      ${Object.entries(d.by_status)
        .map(([s, n]) => `<a class="stage" href="#/orders" data-status="${s}">${badge(s)}<strong>${n}</strong></a>`)
        .join("")}
    </section>
    <section class="card">
      <h2>Daily revenue</h2>
      <div id="chart"></div>
    </section>
    <div class="columns">
      <section class="card">
        <h2>Top records</h2>
        ${d.top_products.length
          ? `<table><thead><tr><th>Record</th><th class="num">Sold</th><th class="num">Revenue</th></tr></thead><tbody>
              ${d.top_products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.quantity}</td><td class="num">${euros(p.revenue)}</td></tr>`).join("")}
            </tbody></table>`
          : `<p class="muted">No sales this month yet.</p>`}
      </section>
      <section class="card">
        <h2>Low stock <span class="muted small">(5 or fewer)</span></h2>
        ${d.low_stock.length
          ? `<table><tbody>${d.low_stock
              .map((p) => `<tr><td>${esc(p.name)}<span class="muted block">${esc(p.artist)}</span></td>
                <td class="num ${p.stock === 0 ? "danger" : ""}">${p.stock}</td>
                <td class="num"><button class="small" data-stock="${esc(p.id)}" data-name="${esc(p.name)}">+ Stock</button></td></tr>`)
              .join("")}</tbody></table>`
          : `<p class="muted">Every record is well stocked.</p>`}
      </section>
    </div>`;

  const [y, m] = d.month.split("-").map(Number);
  columnChart($("#chart"), d.daily.map((day) => ({
    label: String(day.day),
    title: new Date(Date.UTC(y, m - 1, day.day)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
    value: day.revenue,
    orders: day.orders,
  })), { label: "Revenue (€)", format: euros });

  $("#month").addEventListener("change", (e) => {
    if (!e.target.value) return;
    state.month = e.target.value;
    render();
  });
  view.querySelectorAll("[data-status]").forEach((a) => a.addEventListener("click", () => (state.orderFilter = a.dataset.status)));
  view.querySelectorAll("[data-stock]").forEach((b) => b.addEventListener("click", () => stockDialog(b.dataset.stock, b.dataset.name)));
}

// --- Orders -------------------------------------------------------------------
const NEXT = {
  ORDERED: [{ status: "PACKED", label: "Mark packed", primary: true }, { status: "CANCELLED", label: "Cancel" }],
  PACKED: [{ status: "SHIPPED", label: "Mark shipped", primary: true }, { status: "CANCELLED", label: "Cancel" }],
};
const FILTERS = [
  { status: "ORDERED", label: "To pack" },
  { status: "PACKED", label: "To ship" },
  { status: "SHIPPED", label: "Shipped" },
  { status: "CANCELLED", label: "Cancelled" },
  { status: "", label: "All" },
];

function actionButtons(order, small = false) {
  return (NEXT[order.status] ?? [])
    .map((a) => `<button type="button" class="${a.primary ? "primary" : "ghost"}${small ? " small" : ""}" data-order="${esc(order.order_id)}" data-to="${a.status}">${a.label}</button>`)
    .join("");
}

async function orders() {
  const list = await api(`/orders?month=${state.month}${state.orderFilter ? `&status=${state.orderFilter}` : ""}`);
  view.innerHTML = `
    <div class="page-head">
      <h1>Orders</h1>
      <label class="month">Month <input type="month" id="month" value="${esc(state.month)}" max="${thisMonth()}"></label>
    </div>
    <div class="tabs" role="tablist">
      ${FILTERS.map((f) => `<button role="tab" aria-selected="${f.status === state.orderFilter}" data-filter="${f.status}">${f.label}</button>`).join("")}
    </div>
    <section class="card flush">
      ${list.length
        ? `<table class="orders"><thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th>Records</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>
          ${list.map((o) => `<tr>
            <td><button class="link" data-open="${esc(o.order_id)}">${esc(o.order_id.slice(0, 8))}</button></td>
            <td>${dateTime(o.created_at)}</td>
            <td>${esc(o.customer_name)}<span class="muted block">${esc(o.customer_email)}</span></td>
            <td>${o.items.reduce((n, i) => n + i.quantity, 0)}</td>
            <td class="num">${euros(o.total)}</td>
            <td>${badge(o.status)}</td>
            <td class="actions">${actionButtons(o, true)}</td></tr>`).join("")}
          </tbody></table>`
        : `<p class="muted pad">No orders here for ${esc(monthName(state.month))}.</p>`}
    </section>`;

  $("#month").addEventListener("change", (e) => {
    if (!e.target.value) return;
    state.month = e.target.value;
    render();
  });
  view.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.orderFilter = b.dataset.filter;
      render();
    }),
  );
  view.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => orderDialog(b.dataset.open)));
  bindTransitions(view);
}

function bindTransitions(root) {
  root.querySelectorAll("[data-to]").forEach((b) =>
    b.addEventListener("click", async () => {
      const to = b.dataset.to;
      let body = { status: to };
      if (to === "SHIPPED") {
        const tracking = prompt("Carrier tracking number (leave empty to generate one):", "");
        if (tracking === null) return;
        body.tracking_number = tracking;
      }
      if (to === "CANCELLED" && !confirm("Cancel this order? Its records go back in stock.")) return;
      b.disabled = true;
      try {
        await api(`/orders/${b.dataset.order}/status`, { method: "POST", body });
        toast(`Order ${b.dataset.order.slice(0, 8)} → ${STATUS[to].label}`);
        if (dialog.open) dialog.close();
        render();
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
      }
    }),
  );
}

async function orderDialog(id) {
  const o = await api(`/orders/${id}`);
  dialog.innerHTML = `
    <form method="dialog" class="dialog-head"><h2>Order ${esc(o.order_id.slice(0, 8))} ${badge(o.status)}</h2><button class="ghost" aria-label="Close">✕</button></form>
    <p>${esc(o.customer_name)} · <a href="mailto:${esc(o.customer_email)}">${esc(o.customer_email)}</a></p>
    <table><thead><tr><th>Record</th><th class="num">Qty</th><th class="num">Price</th></tr></thead><tbody>
      ${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.quantity}</td><td class="num">${euros(i.unit_price * i.quantity)}</td></tr>`).join("")}
      <tr class="total"><td>Total</td><td></td><td class="num">${euros(o.total)}</td></tr>
    </tbody></table>
    ${o.tracking_number ? `<p>Tracking: <strong>${esc(o.tracking_number)}</strong></p>` : ""}
    <p>${o.packing_slip_url ? `<a href="${esc(o.packing_slip_url)}" target="_blank" rel="noopener">Open packing slip</a>` : `<span class="muted">Packing slip being prepared…</span>`}</p>
    <h3>History</h3>
    <ol class="history">${o.history.map((h) => `<li>${badge(h.status)} <span>${esc(h.detail)}</span> <span class="muted">${dateTime(h.created_at)} · ${esc(h.source)}</span></li>`).join("")}</ol>
    <div class="dialog-actions">${actionButtons(o)}</div>`;
  bindTransitions(dialog);
  dialog.showModal();
}

// --- Products -----------------------------------------------------------------
async function products() {
  const list = await api("/products");
  view.innerHTML = `
    <div class="page-head">
      <h1>Products <span class="muted small">${list.length}</span></h1>
      <a class="button primary" href="#/products/new">New record</a>
    </div>
    <section class="card flush">
      <table class="products"><thead><tr><th></th><th>Record</th><th>Genre</th><th class="num">Price</th><th class="num">Stock</th><th></th></tr></thead><tbody>
        ${list.map((p) => `<tr>
          <td>${p.image ? `<img class="thumb" src="${esc(imageUrl(p.image))}" alt="" loading="lazy">` : `<span class="thumb empty"></span>`}</td>
          <td><strong>${esc(p.name)}</strong><span class="muted block">${esc(p.artist)}${p.year ? ` · ${p.year}` : ""}</span></td>
          <td>${esc(p.genre)}</td>
          <td class="num">${euros(p.price)}</td>
          <td class="num ${p.stock === 0 ? "danger" : p.stock <= 5 ? "warn" : ""}">${p.stock}</td>
          <td class="actions">
            <button class="small" data-stock="${esc(p.id)}" data-name="${esc(p.name)}">+ Stock</button>
            <a class="button small ghost" href="#/products/${esc(p.id)}">Edit</a>
          </td></tr>`).join("")}
      </tbody></table>
    </section>`;
  view.querySelectorAll("[data-stock]").forEach((b) => b.addEventListener("click", () => stockDialog(b.dataset.stock, b.dataset.name)));
}

function stockDialog(id, name) {
  dialog.innerHTML = `
    <form class="stack" id="stockForm">
      <div class="dialog-head"><h2>Add stock</h2><button type="button" class="ghost" id="closeDialog" aria-label="Close">✕</button></div>
      <p>${esc(name)}</p>
      <label>Records received <input type="number" name="quantity" min="1" max="10000" value="10" required autofocus></label>
      <div class="dialog-actions"><button class="primary">Add to stock</button></div>
    </form>`;
  $("#closeDialog", dialog).addEventListener("click", () => dialog.close());
  $("#stockForm", dialog).addEventListener("submit", async (e) => {
    e.preventDefault();
    const quantity = Number(new FormData(e.target).get("quantity"));
    try {
      const product = await api(`/products/${id}/stock`, { method: "POST", body: { quantity } });
      dialog.close();
      toast(`${product.name}: ${product.stock} in stock`);
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });
  dialog.showModal();
}

async function productForm(id) {
  const p = id ? (await api("/products")).find((x) => x.id === id) : {};
  if (id && !p) throw new Error("product not found");
  let imageKey = p.image ?? "";
  view.innerHTML = `
    <div class="page-head"><h1>${id ? `Edit ${esc(p.name)}` : "New record"}</h1><a class="button ghost" href="#/products">Back</a></div>
    <form id="productForm" class="card form-grid">
      <div class="cover">
        <img id="preview" src="${esc(imageUrl(imageKey))}" alt="" ${imageKey ? "" : "hidden"}>
        <span id="noCover" class="no-cover" ${imageKey ? "hidden" : ""}>No cover yet</span>
        <label class="button ghost">Upload cover<input type="file" id="image" accept="image/jpeg,image/png,image/webp" hidden></label>
        <span class="muted small">JPG, PNG or WebP, max 5 MB. Stored in S3.</span>
      </div>
      <div class="fields">
        <label>Album title <input name="name" required maxlength="120" value="${esc(p.name)}"></label>
        <label>Artist <input name="artist" required maxlength="120" value="${esc(p.artist)}"></label>
        <div class="row">
          <label>Genre <input name="genre" required maxlength="40" value="${esc(p.genre)}" list="genres"></label>
          <label>Year <input name="year" type="number" min="1900" max="${new Date().getFullYear() + 1}" value="${esc(p.year)}"></label>
        </div>
        <label>Description <textarea name="description" required maxlength="500" rows="3">${esc(p.description)}</textarea></label>
        <div class="row">
          <label>Price (€) <input name="price" type="number" min="0.01" max="10000" step="0.01" required value="${esc(p.price)}"></label>
          ${id ? `<label>Stock <input value="${p.stock}" disabled><span class="muted small">Use “+ Stock” to restock</span></label>` : `<label>Initial stock <input name="stock" type="number" min="0" max="10000" value="0"></label>`}
        </div>
        <p id="formError" class="error" hidden></p>
        <div class="form-actions"><button class="primary" id="save">${id ? "Save changes" : "Create record"}</button></div>
      </div>
      <datalist id="genres">${["Indie Rock", "Soul", "Jazz", "Synthwave", "Folk", "Ambient", "Hip-Hop", "Funk"].map((g) => `<option value="${g}">`).join("")}</datalist>
    </form>`;

  $("#image").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast("Image is larger than 5 MB", true);
    $("#save").disabled = true;
    toast("Uploading cover…");
    try {
      imageKey = await uploadImage(file);
      $("#preview").src = URL.createObjectURL(file);
      $("#preview").hidden = false;
      $("#noCover").hidden = true;
      toast("Cover uploaded");
    } catch (err) {
      toast(err.message, true);
    } finally {
      $("#save").disabled = false;
    }
  });

  $("#productForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (imageKey) body.image = imageKey;
    $("#formError").hidden = true;
    try {
      const saved = id
        ? await api(`/products/${id}`, { method: "PATCH", body })
        : await api("/products", { method: "POST", body });
      toast(`${saved.name} ${id ? "updated" : "created"}`);
      location.hash = "#/products";
    } catch (err) {
      $("#formError").textContent = err.message;
      $("#formError").hidden = false;
    }
  });
}

// --- Router -------------------------------------------------------------------
async function render() {
  const [, section = "dashboard", id] = location.hash.split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === section));
  try {
    if (section === "orders") await orders();
    else if (section === "products" && id) await productForm(id === "new" ? null : decodeURIComponent(id));
    else if (section === "products") await products();
    else await dashboard();
  } catch (e) {
    view.innerHTML = `<p class="error">Could not load this page: ${esc(e.message)}</p>`;
  }
}

$("#logout").addEventListener("click", logout);
window.addEventListener("hashchange", render);

const me = await session();
$("#who").textContent = me.email ?? "";
render();
