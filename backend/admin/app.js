// Back-office API (Express), a separate ECS service behind the same ALB:
// the listener routes /admin/api/* here. Every route but /health needs an
// admin token (Cognito "admins" group).
import express from "express";
import { STATUSES, getOrder, listOrders, publish, setStatus } from "../lib/orders.js";
import { addStock, createProduct, listProducts, updateProduct } from "../lib/products.js";
import { currentMonth, monthlySales } from "../lib/sales.js";
import { presignDocument, presignImageUpload } from "../lib/uploads.js";
import { requireAdmin } from "./auth.js";

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

export function createAdminApp({ verify }) {
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
    await publish(`ORDER_${status}`, subject, message);
    res.json(order);
  });

  app.use("/admin/api", api);
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "internal error" : err.message });
  });
  return app;
}
