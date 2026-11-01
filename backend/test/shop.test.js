// Shop API + Lambdas against DynamoDB Local (SNS / S3 captured): `npm test`.
import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/app.js";
import { handler as auditStream } from "../functions/audit-stream/index.js";
import { handler as notifyCustomers } from "../functions/customer-notifier/index.js";
import { handler as processOrders } from "../functions/order-processor/index.js";
import { cancelOrder, getOrder, setStatus } from "../lib/orders.js";
import { getProduct } from "../lib/products.js";
import { json, orderEvent, sent, serve, useTables } from "./helpers.js";

useTables();
const verify = async (token) => {
  if (!token.startsWith("user-")) throw new Error("invalid token");
  return { sub: token };
};
const base = serve(createApp({ instance: () => ({ instance: "task-1", az: "eu-west-3a" }), verify }));
const as = (user) => ({ Authorization: `Bearer ${user}` });
const api = (path, init) => fetch(`${base.url}/api${path}`, init);

const validOrder = {
  customer_name: "Test",
  customer_email: "test@example.com",
  items: [{ product_id: "p-001", quantity: 2 }, { product_id: "p-002", quantity: 1 }],
};
const placeOrder = async (body = validOrder) => (await api("/orders", json("POST", body))).json();

test("health reports the ECS task", async () => {
  const res = await api("/health");
  assert.deepEqual(await res.json(), { status: "ok", backend: "ecs", instance: "task-1", az: "eu-west-3a" });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("products are sorted by id", async () => {
  const body = await (await api("/products")).json();
  assert.deepEqual(body.map((p) => p.id), ["p-001", "p-002"]);
});

test("placing an order stores it, takes stock and publishes ORDER_PLACED", async () => {
  const res = await api("/orders", json("POST", validOrder));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.total, 87.3);
  assert.equal(body.status, "ORDERED");

  const order = await (await api(`/orders/${body.order_id}`)).json();
  assert.equal(order.history[0].source, "task-1");
  assert.equal(order.month, order.created_at.slice(0, 7));
  assert.equal((await getProduct("p-001")).stock, 38);
  assert.equal((await getProduct("p-002")).stock, 2);
  assert.equal(sent.sns[0].MessageAttributes.event_type.StringValue, "ORDER_PLACED");
  assert.equal(orderEvent(sent.sns[0]).items.length, 2);
});

test("an order beyond the stock is rejected with 409 and changes nothing", async () => {
  const res = await api("/orders", json("POST", { ...validOrder, items: [{ product_id: "p-001", quantity: 1 }, { product_id: "p-002", quantity: 4 }] }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Saffron Skies/);
  assert.equal((await getProduct("p-001")).stock, 40);
  assert.equal(sent.sns.length, 0);
});

test("invalid orders are rejected with 400", async () => {
  assert.equal((await api("/orders", json("POST", { items: [] }))).status, 400);
  assert.equal((await api("/orders", json("POST", { ...validOrder, items: [{ product_id: "p-001", quantity: 11 }] }))).status, 400);
  const unknown = await api("/orders", json("POST", { ...validOrder, items: [{ product_id: "p-999", quantity: 1 }] }));
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /p-999/);
  const tooMany = Array.from({ length: 26 }, (_, i) => ({ product_id: `p-${i}`, quantity: 1 }));
  assert.equal((await api("/orders", json("POST", { ...validOrder, items: tooMany }))).status, 400);
});

test("unknown order and route return 404", async () => {
  assert.equal((await api("/orders/nope")).status, 404);
  assert.equal((await api("/nope")).status, 404);
});

test("status transitions follow ORDERED -> PACKED -> SHIPPED", async () => {
  const { order_id } = await placeOrder();
  await assert.rejects(setStatus(order_id, "SHIPPED", "too early", "test"), { status: 409 });
  await setStatus(order_id, "PACKED", "packed", "test");
  const shipped = await setStatus(order_id, "SHIPPED", "shipped", "test", { tracking_number: "TRK1" });
  assert.equal(shipped.tracking_number, "TRK1");
  assert.deepEqual(shipped.history.map((h) => h.status), ["ORDERED", "PACKED", "SHIPPED"]);
  await assert.rejects(cancelOrder(order_id, "too late", "test"), { status: 409 });
});

test("cancelling puts the items back in stock", async () => {
  const { order_id } = await placeOrder();
  await setStatus(order_id, "PACKED", "packed", "test");
  const cancelled = await cancelOrder(order_id, "cancelled", "test");
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal((await getProduct("p-001")).stock, 40);
  assert.equal((await getProduct("p-002")).stock, 3);
  await assert.rejects(cancelOrder(order_id, "twice", "test"), { status: 409 });
  assert.equal((await getProduct("p-001")).stock, 40);
});

test("order processor writes a packing slip and links it to the order", async () => {
  const { order_id } = await placeOrder();
  const result = await processOrders({ Records: [{ messageId: "m1", body: JSON.stringify(orderEvent(sent.sns[0])) }] });
  assert.deepEqual(result, { batchItemFailures: [] });
  const slip = sent.s3[0];
  assert.equal(slip.Bucket, "documents");
  assert.equal(slip.Key, `packing-slips/${order_id}.txt`);
  assert.match(slip.Body, /2 {4}Midnight Static/);
  assert.equal((await getOrder(order_id)).packing_slip, slip.Key);
  assert.equal((await getOrder(order_id)).status, "ORDERED"); // packing is confirmed by an admin
});

test("order processor reports failures for retry", async () => {
  const body = JSON.stringify({ order_id: "missing", customer_name: "x", customer_email: "x@y", items: [], total: 0 });
  assert.deepEqual(await processOrders({ Records: [{ messageId: "m1", body }] }), { batchItemFailures: [{ itemIdentifier: "m1" }] });
});

test("audit stream writes one S3 document per change", async () => {
  await auditStream({
    Records: [{ eventID: "e1", eventName: "INSERT", dynamodb: { Keys: { order_id: { S: "o-1" } }, ApproximateCreationDateTime: 1767225600, NewImage: {} } }],
  });
  assert.equal(sent.s3[0].Bucket, "audit");
  assert.equal(sent.s3[0].Key, "orders/dt=2026-01-01/o-1/000000-e1.json");
});

test("customer notifier emails the customer for every status", async () => {
  const { order_id } = await placeOrder();
  await setStatus(order_id, "PACKED", "packed", "test");
  const shipped = await setStatus(order_id, "SHIPPED", "shipped", "test", { tracking_number: "TRK-1" });
  const events = [orderEvent(sent.sns[0]), { ...orderEvent(sent.sns[0]), event_type: "ORDER_PACKED" }, { ...orderEvent(sent.sns[0]), event_type: "ORDER_SHIPPED", tracking_number: shipped.tracking_number }, { ...orderEvent(sent.sns[0]), event_type: "ORDER_CANCELLED" }];
  const result = await notifyCustomers({ Records: events.map((e, i) => ({ messageId: `m${i}`, body: JSON.stringify(e) })) });
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(sent.ses.length, 4);
  assert.ok(sent.ses.every((m) => m.FromEmailAddress === "shop@example.com" && m.Destination.ToAddresses[0] === "test@example.com"));
  assert.match(sent.ses[0].Content.Simple.Subject.Data, /Thank you for your order/);
  assert.match(sent.ses[2].Content.Simple.Body.Text.Data, /Tracking number: TRK-1/);
  assert.match(sent.ses[3].Content.Simple.Subject.Data, /cancelled/);
});

test("customer notifier escapes HTML, ignores other events and reports send failures", async () => {
  const base = { order_id: "abcdef123456", customer_name: "<b>Eve</b>", customer_email: "eve@example.com", items: [], total: 1 };
  await notifyCustomers({ Records: [{ messageId: "a", body: JSON.stringify({ ...base, event_type: "ORDER_PLACED" }) }, { messageId: "b", body: JSON.stringify({ ...base, event_type: "OTHER" }) }] });
  assert.equal(sent.ses.length, 1);
  assert.match(sent.ses[0].Content.Simple.Body.Html.Data, /&lt;b&gt;Eve&lt;\/b&gt;/);
  assert.deepEqual(await notifyCustomers({ Records: [{ messageId: "c", body: "not json" }] }), { batchItemFailures: [{ itemIdentifier: "c" }] });
});

test("a signed-in customer sees only their own orders, newest first", async () => {
  const place = async (user, body = validOrder) => (await api("/orders", json("POST", body, user && as(user)))).json();
  const first = await place("user-a");
  await place("user-b");
  await place(undefined); // guest order: not attached to any account
  const second = await place("user-a", { ...validOrder, items: [{ product_id: "p-001", quantity: 1 }] });

  const mine = await (await api("/me/orders", { headers: as("user-a") })).json();
  assert.deepEqual(mine.map((o) => o.order_id), [second.order_id, first.order_id]);
  assert.equal((await (await api("/me/orders", { headers: as("user-c") })).json()).length, 0);
});

test("/me needs a valid customer token", async () => {
  assert.equal((await api("/me/orders")).status, 401);
  assert.equal((await api("/me/orders", { headers: as("nope") })).status, 401);
  assert.equal((await api("/orders", json("POST", validOrder, as("nope")))).status, 401);
});

test("a customer cancels their order while ORDERED: restocked and announced", async () => {
  const { order_id } = await (await api("/orders", json("POST", validOrder, as("user-a")))).json();
  sent.sns.length = 0;
  const res = await api(`/me/orders/${order_id}/cancel`, json("POST", undefined, as("user-a")));
  assert.equal(res.status, 200);
  const order = await res.json();
  assert.equal(order.status, "CANCELLED");
  assert.equal(order.history.at(-1).detail, "cancelled by the customer");
  assert.equal((await getProduct("p-001")).stock, 40);
  assert.equal(sent.sns[0].MessageAttributes.event_type.StringValue, "ORDER_CANCELLED");
});

test("a customer can't cancel a packed order, nor someone else's", async () => {
  const { order_id } = await (await api("/orders", json("POST", validOrder, as("user-a")))).json();
  assert.equal((await api(`/me/orders/${order_id}/cancel`, json("POST", undefined, as("user-b")))).status, 404);

  await setStatus(order_id, "PACKED", "packed", "test");
  const res = await api(`/me/orders/${order_id}/cancel`, json("POST", undefined, as("user-a")));
  assert.equal(res.status, 409);
  assert.equal((await getOrder(order_id)).status, "PACKED");
  assert.equal((await getProduct("p-001")).stock, 38);
});
