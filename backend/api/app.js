// Shop API (Express), runs as an ECS service behind the ALB.
// CloudFront routes /api/* here; the storefront and images are served from S3.
import express from "express";
import { createOrder, getOrder, listProducts } from "../lib/orders.js";

export function createApp({ instance = () => ({}) } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", backend: "ecs", ...instance() });
  });

  app.get("/api/products", async (req, res) => {
    res.json(await listProducts());
  });

  app.post("/api/orders", async (req, res) => {
    const order = await createOrder(req.body ?? {}, instance().instance ?? "api");
    res.status(201).json({
      order_id: order.order_id,
      status: order.status,
      total: order.total,
      message: `Thank you ${order.customer_name}! Order ${order.order_id.slice(0, 8)} confirmed (${order.total.toFixed(2)} €). A confirmation has been sent.`,
    });
  });

  app.get("/api/orders/:id", async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "order not found" });
    res.json(order);
  });

  app.use((req, res) => res.status(404).json({ error: "not found" }));

  // Express 5 forwards rejected promises here.
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "internal error" : err.message });
  });

  return app;
}
