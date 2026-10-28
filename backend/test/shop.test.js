// Shop API + Lambdas against DynamoDB Local (SNS / S3 captured): `npm test`.
import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../api/app.js";
import { handler as auditStream } from "../functions/audit-stream/index.js";
import { handler as processOrders } from "../functions/order-processor/index.js";
import { cancelOrder, getOrder, setStatus } from "../lib/orders.js";
import { getProduct } from "../lib/products.js";
import { json, orderEvent, sent, serve, useTables } from "./helpers.js";

useTables();
const base = serve(createApp({ instance: () => ({ instance: "task-1", az: "eu-west-3a" }) }));
const api = (path, init) => fetch(`${base.url}/api${path}`, init);

const validOrder = {
  customer_name: "Test",
  customer_email: "test@example.com",
  items: [{ product_id: "p-001", quantity: 2 }, { product_id: "p-002", quantity: 1 }],
};
const placeOrder = async (body = validOrder) => (await api("/orders", json("POST", body))).json();

test("health reports the ECS task", async () => {
  assert.deepEqual(await (await api("/health")).json(), { status: "ok", backend: "ecs", instance: "task-1", az: "eu-west-3a" });
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
