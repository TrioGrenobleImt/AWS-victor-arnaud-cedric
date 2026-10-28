// Order domain shared by the API and the Lambdas: DynamoDB access, the order
// status state machine and SNS events.
import { BatchGetCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PublishCommand } from "@aws-sdk/client-sns";
import { randomUUID } from "node:crypto";
import { ddb, env, sns } from "./aws.js";

export const MAX_QUANTITY = 10;
export const MAX_LINES = 25; // well under the 100-key BatchGetItem limit

// Allowed transitions: target status -> statuses it can be reached from.
// Enforced by DynamoDB conditional writes, so any writer (API or Lambda) is safe:
// e.g. a future "cancel order" cannot race with the shipping simulation.
export const TRANSITIONS = {
  PACKING: ["PENDING"],
  SHIPPED: ["PACKING"],
  CANCELLED: ["PENDING", "PACKING"],
};

export class ValidationError extends Error {
  status = 400;
}

export class InvalidTransitionError extends Error {
  status = 409;
}

const now = () => new Date().toISOString();

export async function listProducts() {
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: env("PRODUCTS_TABLE") }));
  return Items.sort((a, b) => a.id.localeCompare(b.id));
}

function validateOrder({ customer_name, customer_email, items }) {
  if (!customer_name || !customer_email || !String(customer_email).includes("@") || !Array.isArray(items) || !items.length) {
    throw new ValidationError("customer_name, customer_email and items are required");
  }
  if (items.length > MAX_LINES) throw new ValidationError(`at most ${MAX_LINES} different products per order`);
  const quantities = new Map();
  for (const item of items) {
    const qty = Number.parseInt(item?.quantity, 10);
    if (!(qty >= 1 && qty <= MAX_QUANTITY)) throw new ValidationError(`quantity must be between 1 and ${MAX_QUANTITY}`);
    quantities.set(String(item.product_id), qty);
  }
  return quantities;
}

export async function createOrder(body, source) {
  const quantities = validateOrder(body);
  const table = env("PRODUCTS_TABLE");
  const { Responses } = await ddb.send(
    new BatchGetCommand({ RequestItems: { [table]: { Keys: [...quantities.keys()].map((id) => ({ id })) } } }),
  );
  const found = new Map(Responses[table].map((p) => [p.id, p]));
  const missing = [...quantities.keys()].filter((id) => !found.has(id));
  if (missing.length) throw new ValidationError(`unknown products: ${missing.sort().join(", ")}`);

  const lines = [...quantities].map(([id, quantity]) => ({
    product_id: id,
    name: found.get(id).name,
    quantity,
    unit_price: found.get(id).price,
  }));
  const total = Math.round(lines.reduce((sum, l) => sum + l.unit_price * l.quantity, 0) * 100) / 100;
  const timestamp = now();
  const order = {
    order_id: randomUUID(),
    customer_name: body.customer_name,
    customer_email: body.customer_email,
    items: lines,
    total,
    status: "PENDING",
    created_at: timestamp,
    updated_at: timestamp,
    history: [{ status: "PENDING", detail: "order placed", source, created_at: timestamp }],
  };
  await ddb.send(new PutCommand({ TableName: env("ORDERS_TABLE"), Item: order }));

  const summary = lines.map((l) => `  - ${l.quantity} x ${l.name}`).join("\n");
  await publish("ORDER_PLACED", `Order confirmation ${order.order_id.slice(0, 8)}`, {
    default: JSON.stringify({ event_type: "ORDER_PLACED", ...pick(order, "order_id", "customer_name", "customer_email", "total", "items") }),
    email: `Hello ${order.customer_name},\n\nThank you for your order ${order.order_id}.\n${summary}\nTotal: ${total.toFixed(2)} EUR\n`,
  });
  return order;
}

export async function getOrder(orderId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: env("ORDERS_TABLE"), Key: { order_id: orderId }, ConsistentRead: true }));
  return Item;
}

/** Moves an order to `status`, only if its current status allows it (see TRANSITIONS). */
export async function setStatus(orderId, status, detail, source) {
  const from = TRANSITIONS[status];
  if (!from) throw new Error(`unknown status ${status}`);
  const timestamp = now();
  const fromValues = Object.fromEntries(from.map((s, i) => [`:from${i}`, s]));
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: env("ORDERS_TABLE"),
        Key: { order_id: orderId },
        UpdateExpression: "SET #s = :s, updated_at = :t, history = list_append(history, :h)",
        ConditionExpression: `#s IN (${Object.keys(fromValues).join(", ")})`,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": status,
          ":t": timestamp,
          ":h": [{ status, detail, source, created_at: timestamp }],
          ...fromValues,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    console.log(JSON.stringify({ order_id: orderId, status }));
    return Attributes;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      throw new InvalidTransitionError(`order ${orderId} cannot move to ${status}`);
    }
    throw err;
  }
}

/** Publishes an order event; `message` is either a string or a per-protocol object (MessageStructure=json). */
export async function publish(eventType, subject, message) {
  const structured = typeof message !== "string";
  await sns.send(
    new PublishCommand({
      TopicArn: env("TOPIC_ARN"),
      Subject: subject,
      Message: structured ? JSON.stringify(message) : message,
      MessageStructure: structured ? "json" : undefined,
      MessageAttributes: { event_type: { DataType: "String", StringValue: eventType } },
    }),
  );
}

const pick = (obj, ...keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
