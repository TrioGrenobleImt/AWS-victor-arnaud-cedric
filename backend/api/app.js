// Shop API (Express), runs as an ECS service behind the ALB.
// CloudFront routes /api/* here; the storefront and images are served from S3.
import express from "express";
import { cancelOrder, createOrder, eventPayload, getOrder, listCustomerOrders, publish } from "../lib/orders.js";
import { listProducts } from "../lib/products.js";
import { optionalCustomer, requireCustomer } from "./auth.js";

export function createApp({ instance = () => ({}), verify } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", backend: "ecs", ...instance() });
  });

  app.get("/api/products", async (req, res) => {
    res.json(await listProducts());
  });

  // Guests can order; with a customer token the order is attached to the account.
  app.post("/api/orders", optionalCustomer(verify), async (req, res) => {
    const order = await createOrder(req.body ?? {}, instance().instance ?? "api", req.customer?.sub);
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

  // --- Signed-in customers: their orders, and cancelling while still ORDERED ---
  const mine = express.Router();
  mine.use(requireCustomer(verify));

  mine.get("/orders", async (req, res) => res.json(await listCustomerOrders(req.customer.sub)));

  mine.post("/orders/:id/cancel", async (req, res) => {
    // Someone else's order looks like a missing one.
    const order = await getOrder(req.params.id);
    if (!order || order.customer_id !== req.customer.sub) return res.status(404).json({ error: "order not found" });
    // Only before the shop packs it: the conditional write also guards against a concurrent PACKED.
    const cancelled = await cancelOrder(order.order_id, "cancelled by the customer", `customer:${req.customer.sub}`, ["ORDERED"]);
    await publish("ORDER_CANCELLED", `Order ${order.order_id.slice(0, 8)} cancelled`, {
      default: eventPayload("ORDER_CANCELLED", cancelled),
      email: `Hello ${cancelled.customer_name},\n\nYour order ${cancelled.order_id} has been cancelled.\n`,
    });
    res.json(cancelled);
  });

  app.use("/api/me", mine);

  app.use((req, res) => res.status(404).json({ error: "not found" }));

  // Express 5 forwards rejected promises here.
  app.use((err, req, res, next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "internal error" : err.message });
  });

  return app;
}
