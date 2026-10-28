// Back-office API (Express), a separate ECS service behind the same ALB:
// the listener routes /admin/api/* here. Every route but /health needs an
// admin token (Cognito "admins" group); /users needs the "owner" role too.
import express from "express";
import { STATUSES, eventPayload, getOrder, listOrders, publish, setStatus } from "../lib/orders.js";
import { addStock, createProduct, listProducts, updateProduct } from "../lib/products.js";
import { currentMonth, monthlySales } from "../lib/sales.js";
import { presignDocument, presignImageUpload } from "../lib/uploads.js";
import { ROLES, requireAdmin, requireOwner } from "./auth.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const NOTIFY = {
  PACKED: (o) => [`Order ${o.order_id.slice(0, 8)} packed`, `Hello ${o.customer_name},\n\nYour order ${o.order_id} is packed and will ship soon.\n`],
  SHIPPED: (o) => [`Order ${o.order_id.slice(0, 8)} shipped`, `Hello ${o.customer_name},\n\nYour order ${o.order_id} has shipped. Tracking: ${o.tracking_number}\n`],
  CANCELLED: (o) => [`Order ${o.order_id.slice(0, 8)} cancelled`, `Hello ${o.customer_name},\n\nYour order ${o.order_id} has been cancelled.\n`],
};

function month(req) {
  const value = req.query.month ?? currentMonth();
  if (!MONTH.test(value)) throw Object.assign(new Error("month must be YYYY-MM"), { status: 400 });
  return value;
}

export function createAdminApp({ verify, directory }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store"); // never cached by CloudFront or the browser
    next();
  });

  const api = express.Router();
  api.get("/health", (req, res) => res.json({ status: "ok", backend: "admin" }));
  api.use(requireAdmin(verify));

  api.get("/me", (req, res) => res.json(req.admin));

  api.get("/dashboard", async (req, res) => res.json(await monthlySales(month(req))));

  // --- Products ---------------------------------------------------------------
  api.get("/products", async (req, res) => res.json(await listProducts()));

  api.post("/products", async (req, res) => res.status(201).json(await createProduct(req.body ?? {})));

  api.patch("/products/:id", async (req, res) => {
    const product = await updateProduct(req.params.id, req.body ?? {});
    if (!product) return res.status(404).json({ error: "product not found" });
    res.json(product);
  });

  api.post("/products/:id/stock", async (req, res) => {
    const product = await addStock(req.params.id, req.body?.quantity);
    if (!product) return res.status(404).json({ error: "product not found" });
    res.json(product);
  });

  api.post("/uploads", async (req, res) => res.status(201).json(await presignImageUpload(req.body?.content_type)));

  // --- Orders -------------------------------------------------------------------
  api.get("/orders", async (req, res) => {
    const status = req.query.status;
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    res.json(await listOrders(month(req), status));
  });

  api.get("/orders/:id", async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    res.json({ ...order, packing_slip_url: order.packing_slip ? await presignDocument(order.packing_slip) : null });
  });

  api.post("/orders/:id/status", async (req, res) => {
    const { status, tracking_number } = req.body ?? {};
    const source = `admin:${req.admin.username}`;
    let extra;
    let detail = { PACKED: "packed", CANCELLED: "cancelled by the shop" }[status];
    if (status === "SHIPPED") {
      const tracking = String(tracking_number ?? "").trim() || `TRK${Math.floor(1e8 + Math.random() * 9e8)}`;
      if (tracking.length > 64) return res.status(400).json({ error: "tracking_number is too long" });
      extra = { tracking_number: tracking };
      detail = `shipped with tracking number ${tracking}`;
    }
    const order = await setStatus(req.params.id, status, detail, source, extra);
    const [subject, message] = NOTIFY[status](order);
    await publish(`ORDER_${status}`, subject, { default: eventPayload(`ORDER_${status}`, order), email: message });
    res.json(order);
  });

  // --- Team (owners only) ---------------------------------------------------------
  const team = express.Router();
  team.use(requireOwner(directory));

  // Mutations target an existing back-office user, never the caller: an owner
  // can't lock themselves out, so there is always at least one owner left.
  const target = async (req, res, next) => {
    if (req.params.username === req.admin.username) return res.status(409).json({ error: "you can't change your own account" });
    req.target = await directory.get(req.params.username);
    if (!req.target) return res.status(404).json({ error: "user not found" });
    next();
  };

  team.get("/", async (req, res) => res.json((await directory.list()).map((u) => ({ ...u, you: u.username === req.admin.username }))));

  team.post("/", async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const role = req.body?.role ?? "staff";
    if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: "a valid email is required" });
    if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
    const user = await directory.create({ email, role });
    if (!user) return res.status(409).json({ error: "an account with this email already exists" });
    res.status(201).json(user);
  });

  team.patch("/:username", target, async (req, res) => {
    const { role, enabled } = req.body ?? {};
    if (role === undefined && enabled === undefined) return res.status(400).json({ error: "role or enabled is required" });
    if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
    if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    if (role !== undefined && role !== req.target.role) await directory.setRole(req.target.username, role);
    if (enabled !== undefined && enabled !== req.target.enabled) await directory.setEnabled(req.target.username, enabled);
    res.json(await directory.get(req.target.username));
  });

  team.delete("/:username", target, async (req, res) => {
    await directory.remove(req.target.username);
    res.status(204).end();
  });

  api.use("/users", team);

  app.use("/admin/api", api);
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "internal error" : err.message });
  });
  return app;
}
