// Unit tests with the AWS clients stubbed: `npm test` (no AWS account needed).
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ddb, s3, sns } from "../lib/aws.js";
import { createApp } from "../api/app.js";
import { handler as processOrders } from "../functions/order-processor/index.js";
import { handler as auditStream } from "../functions/audit-stream/index.js";

Object.assign(process.env, { PRODUCTS_TABLE: "products", ORDERS_TABLE: "orders", TOPIC_ARN: "arn:topic", AUDIT_BUCKET: "audit" });

const products = [
  { id: "p-001", name: "Midnight Static", price: 27.9, stock: 40 },
  { id: "p-002", name: "Saffron Skies", price: 31.5, stock: 25 },
];
let orders, published, objects;

// Minimal in-memory DynamoDB: just what lib/orders.js uses.
ddb.send = async (cmd) => {
  const input = cmd.input;
  switch (cmd.constructor.name) {
    case "ScanCommand":
      return { Items: [...products].reverse() };
    case "BatchGetCommand": {
      const keys = input.RequestItems.products.Keys.map((k) => k.id);
      return { Responses: { products: products.filter((p) => keys.includes(p.id)) } };
    }
    case "PutCommand":
      orders.set(input.Item.order_id, structuredClone(input.Item));
      return {};
    case "GetCommand":
      return { Item: orders.get(input.Key.order_id) };
    case "UpdateCommand": {
      const order = orders.get(input.Key.order_id);
      const values = input.ExpressionAttributeValues;
      const allowed = Object.entries(values).filter(([k]) => k.startsWith(":from")).map(([, v]) => v);
      if (!order || !allowed.includes(order.status)) {
        throw Object.assign(new Error("conditional check failed"), { name: "ConditionalCheckFailedException" });
      }
      Object.assign(order, { status: values[":s"], updated_at: values[":t"], history: [...order.history, ...values[":h"]] });
      return { Attributes: order };
    }
    default:
      throw new Error(`unexpected ${cmd.constructor.name}`);
  }
};
sns.send = async (cmd) => void published.push(cmd.input);
s3.send = async (cmd) => void objects.push(cmd.input);

let server, base;
before(async () => {
  server = createApp({ instance: () => ({ instance: "task-1", az: "eu-west-3a" }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());
beforeEach(() => {
  orders = new Map();
  published = [];
  objects = [];
});

const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const validOrder = {
  customer_name: "Test",
  customer_email: "test@example.com",
  items: [{ product_id: "p-001", quantity: 2 }, { product_id: "p-002", quantity: 1 }],
};

test("health reports the ECS task", async () => {
  assert.deepEqual(await (await fetch(base + "/health")).json(), { status: "ok", backend: "ecs", instance: "task-1", az: "eu-west-3a" });
});

test("products are sorted by id", async () => {
  const body = await (await fetch(base + "/products")).json();
  assert.deepEqual(body.map((p) => p.id), ["p-001", "p-002"]);
});

test("placing an order stores it and publishes ORDER_PLACED", async () => {
  const res = await post("/orders", validOrder);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.total, 87.3);
  assert.equal(orders.get(body.order_id).status, "PENDING");
  assert.equal(published[0].MessageAttributes.event_type.StringValue, "ORDER_PLACED");
  assert.equal(JSON.parse(JSON.parse(published[0].Message).default).items.length, 2);

  const order = await (await fetch(`${base}/orders/${body.order_id}`)).json();
  assert.equal(order.history[0].source, "task-1");
});

test("invalid orders are rejected with 400", async () => {
  assert.equal((await post("/orders", { items: [] })).status, 400);
  assert.equal((await post("/orders", { ...validOrder, items: [{ product_id: "p-001", quantity: 11 }] })).status, 400);
  const unknown = await post("/orders", { ...validOrder, items: [{ product_id: "p-999", quantity: 1 }] });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /p-999/);
  const tooMany = Array.from({ length: 26 }, (_, i) => ({ product_id: `p-${i}`, quantity: 1 }));
  assert.equal((await post("/orders", { ...validOrder, items: tooMany })).status, 400);
});

test("unknown order and route return 404", async () => {
  assert.equal((await fetch(`${base}/orders/nope`)).status, 404);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("processor moves PENDING -> PACKING -> SHIPPED and publishes ORDER_SHIPPED", { timeout: 10000 }, async () => {
  const { order_id } = await (await post("/orders", validOrder)).json();
  const event = JSON.parse(JSON.parse(published[0].Message).default);
  const result = await processOrders({ Records: [{ messageId: "m1", body: JSON.stringify(event) }] }, { functionName: "processor" });
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(orders.get(order_id).history.map((h) => h.status), ["PENDING", "PACKING", "SHIPPED"]);
  assert.equal(published.at(-1).MessageAttributes.event_type.StringValue, "ORDER_SHIPPED");
});

test("processor skips orders that can no longer move (e.g. cancelled)", async () => {
  const { order_id } = await (await post("/orders", validOrder)).json();
  orders.get(order_id).status = "CANCELLED";
  const event = JSON.parse(JSON.parse(published[0].Message).default);
  const result = await processOrders({ Records: [{ messageId: "m1", body: JSON.stringify(event) }] }, { functionName: "processor" });
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(orders.get(order_id).status, "CANCELLED");
});

test("audit stream writes one S3 document per change", async () => {
  await auditStream({
    Records: [{ eventID: "e1", eventName: "INSERT", dynamodb: { Keys: { order_id: { S: "o-1" } }, ApproximateCreationDateTime: 1767225600, NewImage: {} } }],
  });
  assert.equal(objects[0].Bucket, "audit");
  assert.equal(objects[0].Key, "orders/dt=2026-01-01/o-1/000000-e1.json");
});
