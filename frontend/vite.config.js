import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// `npm run dev` works in two modes:
//   - SHOP_BACKEND=<base_url> npm run dev : /api and /images are proxied to a deployed stack
//   - npm run dev                          : a small in-memory mock of the API (same contract
//                                            as backend/api), images served from images/
const backend = process.env.SHOP_BACKEND;
const root = resolve(import.meta.dirname, "..");

function mockApi() {
  const catalog = JSON.parse(readFileSync(resolve(root, "data", "catalog.json"), "utf8"));
  const orders = new Map();
  const STEPS = ["ORDERED", "PACKED", "SHIPPED"]; // moved by the back office in the real stack
  const STEP_MS = 12000; // long enough to try cancelling an ORDERED order
  const statusOf = (o) => (o.cancelled ? "CANCELLED" : STEPS[Math.min(2, Math.floor((Date.now() - o.placed) / STEP_MS))]);
  const view = (o) => ({ ...o, status: statusOf(o) });
  const customerOf = (req) => (req.headers.authorization ?? "").match(/^Bearer dev:(.+)$/)?.[1]; // dev sign-in token
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  return {
    name: "mock-api",
    configureServer(server) {
      server.middlewares.use("/images", (req, res, next) => {
        const file = resolve(root, "images", "." + decodeURIComponent(req.url.split("?")[0]));
        if (!file.startsWith(resolve(root, "images"))) return next();
        try {
          const body = readFileSync(file);
          res.setHeader("Content-Type", req.url.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream");
          res.end(body);
        } catch {
          next();
        }
      });
      server.middlewares.use("/api", (req, res) => {
        const url = req.url.split("?")[0];
        if (req.method === "GET" && url === "/health") return send(res, 200, { status: "ok", backend: "mock", instance: "vite", az: "local" });
        if (req.method === "GET" && url === "/products") return send(res, 200, catalog);
        if (req.method === "GET" && url.startsWith("/orders/")) {
          const order = orders.get(url.slice("/orders/".length));
          if (!order) return send(res, 404, { error: "order not found" });
          return send(res, 200, view(order));
        }
        if (url.startsWith("/me/")) {
          const customer = customerOf(req);
          if (!customer) return send(res, 401, { error: "sign in required" });
          if (req.method === "GET" && url === "/me/orders") {
            const mine = [...orders.values()].filter((o) => o.customer_id === customer).reverse();
            return send(res, 200, mine.map(view));
          }
          const cancel = url.match(/^\/me\/orders\/([^/]+)\/cancel$/);
          const order = cancel && orders.get(cancel[1]);
          if (req.method === "POST" && order?.customer_id === customer) {
            if (statusOf(order) !== "ORDERED") return send(res, 409, { error: `order ${order.order_id} cannot move to CANCELLED` });
            order.cancelled = true;
            return send(res, 200, view(order));
          }
          return send(res, 404, { error: "order not found" });
        }
        if (req.method === "POST" && url === "/orders") {
          let raw = "";
          req.on("data", (chunk) => (raw += chunk));
          req.on("end", () => {
            const body = JSON.parse(raw || "{}");
            const items = body.items || [];
            if (!body.customer_name || !body.customer_email?.includes("@") || !items.length) {
              return send(res, 400, { error: "customer_name, customer_email and items are required" });
            }
            const total = items.reduce((sum, i) => sum + catalog.find((p) => p.id === i.product_id).price * i.quantity, 0);
            const order_id = randomUUID();
            const lines = items.map((i) => ({ ...i, name: catalog.find((p) => p.id === i.product_id).name }));
            orders.set(order_id, { order_id, items: lines, total, placed: Date.now(), created_at: new Date().toISOString(), customer_id: customerOf(req) });
            send(res, 201, {
              order_id,
              status: "ORDERED",
              total,
              message: `Thank you ${body.customer_name}! Order ${order_id.slice(0, 8)} confirmed (${total.toFixed(2)} €).`,
            });
          });
          return;
        }
        send(res, 404, { error: "not found" });
      });
    },
  };
}

// Sign-in settings: the mock and the local backend (`npm run dev` in backend/) accept
// "dev" tokens; a deployed stack serves its own Cognito config.json through the proxy.
const devConfig = {
  name: "dev-config",
  configureServer(server) {
    server.middlewares.use("/config.json", (req, res, next) => {
      if (backend && !/localhost|127\.0\.0\.1/.test(backend)) return next();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ auth: "dev" }));
    });
  },
};

export default defineConfig({
  plugins: backend ? [devConfig] : [devConfig, mockApi()],
  server: backend
    ? {
        proxy: {
          "/api": { target: backend, changeOrigin: true },
          "/config.json": { target: backend, changeOrigin: true },
          "/images": { target: backend, changeOrigin: true },
        },
      }
    : {},
});
