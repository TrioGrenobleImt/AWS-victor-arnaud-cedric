// Admin API against DynamoDB Local (SNS / S3 captured), with a fake token verifier.
import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdminApp } from "../admin/app.js";
import { createApp } from "../api/app.js";
import { getProduct } from "../lib/products.js";
import { memoryDirectory } from "../dev/memory-directory.js";
import { json, sent, serve, useTables } from "./helpers.js";

useTables();
const IDENTITIES = {
  "admin-token": { username: "alice", groups: ["admins", "owners"] },
  "staff-token": { username: "sam", groups: ["admins"] },
};
const verify = async (token) => {
  if (!IDENTITIES[token]) throw new Error("invalid");
  return IDENTITIES[token];
};
const directory = memoryDirectory([
  { username: "alice", email: "alice@example.com", role: "owner" },
  { username: "sam", email: "sam@example.com", role: "staff" },
  { username: "olga", email: "olga@example.com", role: "owner" },
]);
const admin = serve(createAdminApp({ verify, directory }));
const shop = serve(createApp());
const AUTH = { Authorization: "Bearer admin-token" };
const call = (path, method = "GET", body) => fetch(`${admin.url}/admin/api${path}`, json(method, body, AUTH));
const placeOrder = async (items = [{ product_id: "p-001", quantity: 2 }]) =>
  (await fetch(`${shop.url}/api/orders`, json("POST", { customer_name: "Bob", customer_email: "bob@example.com", items }))).json();

test("health is public, everything else needs an admin token", async () => {
  assert.equal((await fetch(`${admin.url}/admin/api/health`)).status, 200);
  assert.equal((await fetch(`${admin.url}/admin/api/products`)).status, 401);
  assert.equal((await fetch(`${admin.url}/admin/api/products`, { headers: { Authorization: "Bearer nope" } })).status, 401);
  const me = await call("/me");
  assert.equal(me.status, 200);
  assert.equal(me.headers.get("cache-control"), "no-store");
  assert.deepEqual(await me.json(), { username: "alice", groups: ["admins", "owners"], role: "owner" });
});

test("admins create products, validated", async () => {
  const res = await call("/products", "POST", {
    name: "New Record", artist: "Someone", genre: "Jazz", description: "Fresh pressing", price: "19.999", year: 2024, stock: 7,
    image: "images/uploads/abc.png",
  });
  assert.equal(res.status, 201);
  const product = await res.json();
  assert.match(product.id, /^p-[0-9a-f]{8}$/);
  assert.equal(product.price, 20);
  assert.equal(product.stock, 7);

  const shopList = await (await fetch(`${shop.url}/api/products`)).json();
  assert.ok(shopList.some((p) => p.id === product.id), "visible in the shop");

  assert.equal((await call("/products", "POST", { name: "x" })).status, 400);
  assert.equal((await call("/products", "POST", { name: "x", artist: "y", genre: "z", description: "d", price: 5, image: "../etc/passwd" })).status, 400);
});

test("admins edit products and add stock", async () => {
  const updated = await (await call("/products/p-001", "PATCH", { price: 25, image: "images/uploads/new.webp" })).json();
  assert.equal(updated.price, 25);
  assert.equal(updated.image, "images/uploads/new.webp");
  assert.equal(updated.name, "Midnight Static");
  assert.equal((await call("/products/p-404", "PATCH", { price: 25 })).status, 404);

  const restocked = await (await call("/products/p-002/stock", "POST", { quantity: 12 })).json();
  assert.equal(restocked.stock, 15);
  assert.equal((await call("/products/p-002/stock", "POST", { quantity: 0 })).status, 400);
  assert.equal((await call("/products/p-404/stock", "POST", { quantity: 1 })).status, 404);
});

test("image uploads get a presigned POST limited to images", async () => {
  const res = await call("/uploads", "POST", { content_type: "image/png" });
  assert.equal(res.status, 201);
  const upload = await res.json();
  assert.match(upload.key, /^images\/uploads\/[0-9a-f-]{36}\.png$/);
  assert.equal(upload.fields.key, upload.key);
  assert.equal(upload.fields["Content-Type"], "image/png");
  assert.ok(upload.fields.Policy);
  assert.equal((await call("/uploads", "POST", { content_type: "image/svg+xml" })).status, 400);
});

test("admins move orders ORDERED -> PACKED -> SHIPPED, with notifications", async () => {
  const { order_id } = await placeOrder();
  assert.equal((await call(`/orders/${order_id}/status`, "POST", { status: "SHIPPED" })).status, 409);

  const packed = await (await call(`/orders/${order_id}/status`, "POST", { status: "PACKED" })).json();
  assert.equal(packed.status, "PACKED");
  assert.equal(packed.history.at(-1).source, "admin:alice");

  const shipped = await (await call(`/orders/${order_id}/status`, "POST", { status: "SHIPPED", tracking_number: "COLISSIMO-42" })).json();
  assert.equal(shipped.tracking_number, "COLISSIMO-42");
  assert.deepEqual(sent.sns.map((m) => m.MessageAttributes.event_type.StringValue), ["ORDER_PLACED", "ORDER_PACKED", "ORDER_SHIPPED"]);
  assert.match(sent.sns.at(-1).Message, /COLISSIMO-42/);

  assert.equal((await call(`/orders/${order_id}/status`, "POST", { status: "BOGUS" })).status, 400);
});

test("cancelling from the back office restocks", async () => {
  const { order_id } = await placeOrder([{ product_id: "p-002", quantity: 3 }]);
  assert.equal((await getProduct("p-002")).stock, 0);
  const cancelled = await (await call(`/orders/${order_id}/status`, "POST", { status: "CANCELLED" })).json();
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal((await getProduct("p-002")).stock, 3);
});

test("orders list by month and status, newest first; detail has the packing slip link", async () => {
  const first = await placeOrder();
  const second = await placeOrder();
  await call(`/orders/${first.order_id}/status`, "POST", { status: "PACKED" });

  const all = await (await call("/orders")).json();
  assert.ok(all.findIndex((o) => o.order_id === second.order_id) < all.findIndex((o) => o.order_id === first.order_id));
  const packed = await (await call("/orders?status=PACKED")).json();
  assert.ok(packed.every((o) => o.status === "PACKED"));
  assert.ok(packed.some((o) => o.order_id === first.order_id));
  assert.deepEqual(await (await call("/orders?month=1999-01")).json(), []);
  assert.equal((await call("/orders?month=2026-13")).status, 400);

  const detail = await (await call(`/orders/${first.order_id}`)).json();
  assert.equal(detail.packing_slip_url, null); // the Lambda has not run in this test
  assert.equal((await call("/orders/nope")).status, 404);
});

test("dashboard sums this month's sales, excluding cancelled orders", async () => {
  const before = await (await call("/dashboard")).json();
  await placeOrder([{ product_id: "p-001", quantity: 2 }]); // 55.80
  const cancelled = await placeOrder([{ product_id: "p-002", quantity: 1 }]);
  await call(`/orders/${cancelled.order_id}/status`, "POST", { status: "CANCELLED" });

  const after = await (await call("/dashboard")).json();
  assert.equal(after.month, new Date().toISOString().slice(0, 7));
  assert.equal(Math.round((after.revenue - before.revenue) * 100) / 100, 55.8);
  assert.equal(after.orders - before.orders, 1);
  assert.equal(after.by_status.CANCELLED - before.by_status.CANCELLED, 1);
  const today = Number(new Date().toISOString().slice(8, 10));
  assert.ok(after.daily[today - 1].revenue >= 55.8);
  assert.equal(after.top_products[0].product_id, "p-001");
  assert.ok(after.low_stock.some((p) => p.id === "p-002")); // stock 3 <= 5
});

// --- Team management ------------------------------------------------------------
const as = (token) => (path, method = "GET", body) => fetch(`${admin.url}/admin/api${path}`, json(method, body, { Authorization: `Bearer ${token}` }));
const staff = as("staff-token");

test("staff use the app but can't touch the team", async () => {
  assert.deepEqual(await (await staff("/me")).json(), { username: "sam", groups: ["admins"], role: "staff" });
  assert.equal((await staff("/products")).status, 200);
  assert.equal((await staff("/users")).status, 403);
  assert.equal((await staff("/users", "POST", { email: "x@example.com", role: "owner" })).status, 403);
  assert.equal((await staff("/users/olga", "PATCH", { role: "staff" })).status, 403);
  assert.equal((await staff("/users/olga", "DELETE")).status, 403);
  assert.equal((await fetch(`${admin.url}/admin/api/users`)).status, 401);
});

test("owners list the team, flagging themselves", async () => {
  const users = await (await call("/users")).json();
  assert.deepEqual(users.map((u) => [u.email, u.role, u.you]), [
    ["alice@example.com", "owner", true],
    ["olga@example.com", "owner", false],
    ["sam@example.com", "staff", false],
  ]);
});

test("owners invite team members, validated", async () => {
  const res = await call("/users", "POST", { email: "  New.Hire@Example.com ", role: "staff" });
  assert.equal(res.status, 201);
  const user = await res.json();
  assert.equal(user.email, "new.hire@example.com");
  assert.equal(user.role, "staff");
  assert.equal(user.status, "FORCE_CHANGE_PASSWORD");
  assert.deepEqual(directory.invitations, ["new.hire@example.com"]);

  assert.equal((await call("/users", "POST", { email: "new.hire@example.com" })).status, 409);
  assert.equal((await call("/users", "POST", { email: "not-an-email" })).status, 400);
  assert.equal((await call("/users", "POST", { email: "a@example.com", role: "superuser" })).status, 400);
  assert.equal((await call(`/users/${user.username}`, "DELETE")).status, 204);
});

test("owners change roles, disable and remove accounts", async () => {
  const promoted = await (await call("/users/sam", "PATCH", { role: "owner" })).json();
  assert.equal(promoted.role, "owner");
  assert.equal((await call("/users/sam", "PATCH", { role: "staff", enabled: false })).status, 200);
  const demoted = (await (await call("/users")).json()).find((u) => u.username === "sam");
  assert.deepEqual([demoted.role, demoted.enabled], ["staff", false]);

  assert.equal((await call("/users/sam", "PATCH", {})).status, 400);
  assert.equal((await call("/users/sam", "PATCH", { role: "boss" })).status, 400);
  assert.equal((await call("/users/sam", "PATCH", { enabled: "no" })).status, 400);
  assert.equal((await call("/users/ghost", "PATCH", { role: "staff" })).status, 404);
  assert.equal((await call("/users/ghost", "DELETE")).status, 404);

  await call("/users/sam", "PATCH", { enabled: true });
});

test("owners can't lock themselves out, and a demoted owner loses team access at once", async () => {
  assert.equal((await call("/users/alice", "PATCH", { role: "staff" })).status, 409);
  assert.equal((await call("/users/alice", "PATCH", { enabled: false })).status, 409);
  assert.equal((await call("/users/alice", "DELETE")).status, 409);

  const olga = as("admin-token"); // alice stays owner; olga is demoted then can't use a stale owner token
  IDENTITIES["olga-token"] = { username: "olga", groups: ["admins", "owners"] };
  assert.equal((await as("olga-token")("/users")).status, 200);
  await olga("/users/olga", "PATCH", { role: "staff" });
  assert.equal((await as("olga-token")("/users")).status, 403);
  assert.equal((await as("olga-token")("/products")).status, 200, "still a back-office user");
});
