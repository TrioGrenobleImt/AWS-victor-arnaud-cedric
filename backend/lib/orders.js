// Order domain shared by the shop API, the admin API and the Lambdas:
// DynamoDB access, the order status state machine, stock and SNS events.
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PublishCommand } from "@aws-sdk/client-sns";
import { randomUUID } from "node:crypto";
import { ddb, env, sns } from "./aws.js";

export const MAX_QUANTITY = 10;
export const MAX_LINES = 25; // TransactWriteItems: 1 order + 1 stock update per line, max 100

// ORDERED -> PACKED -> SHIPPED, moved by the back office. Allowed transitions:
// target status -> statuses it can be reached from. Enforced by DynamoDB
// conditional writes, so concurrent writers (two admins, a Lambda) are safe.
export const TRANSITIONS = {
  PACKED: ["ORDERED"],
  SHIPPED: ["PACKED"],
  CANCELLED: ["ORDERED", "PACKED"],
};
export const STATUSES = ["ORDERED", "PACKED", "SHIPPED", "CANCELLED"];

export class ValidationError extends Error {
  status = 400;
}

export class ConflictError extends Error {
  status = 409;
}

export class InvalidTransitionError extends ConflictError {}

export const now = () => new Date().toISOString();
export const monthOf = (iso) => iso.slice(0, 7); // "2026-10": partition key of the by_month index

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

/** Stores the order and takes the items out of stock in one transaction. */
export async function createOrder(body, source) {
  const quantities = validateOrder(body);
  const productsTable = env("PRODUCTS_TABLE");
  const { Responses } = await ddb.send(
    new BatchGetCommand({ RequestItems: { [productsTable]: { Keys: [...quantities.keys()].map((id) => ({ id })) } } }),
  );
  const found = new Map(Responses[productsTable].map((p) => [p.id, p]));
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
    month: monthOf(timestamp),
    customer_name: body.customer_name,
    customer_email: body.customer_email,
    items: lines,
    total,
    status: "ORDERED",
    created_at: timestamp,
    updated_at: timestamp,
    history: [{ status: "ORDERED", detail: "order placed", source, created_at: timestamp }],
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: env("ORDERS_TABLE"), Item: order } },
          ...lines.map((l) => ({
            Update: {
              TableName: productsTable,
              Key: { id: l.product_id },
              UpdateExpression: "SET stock = stock - :q",
              ConditionExpression: "stock >= :q",
              ExpressionAttributeValues: { ":q": l.quantity },
            },
          })),
        ],
      }),
    );
  } catch (err) {
    if (err.name !== "TransactionCanceledException") throw err;
    // CancellationReasons[0] is the order Put, then one entry per line.
    const short = (err.CancellationReasons ?? []).slice(1).flatMap((r, i) => (r.Code === "ConditionalCheckFailed" ? [lines[i].name] : []));
    throw new ConflictError(short.length ? `not enough stock for: ${short.join(", ")}` : "order could not be placed, please retry");
  }

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

/** Orders of one month (by_month index), newest first, optionally filtered by status. */
export async function listOrders(month, status) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: env("ORDERS_TABLE"),
        IndexName: "by_month",
        KeyConditionExpression: "#m = :m",
        FilterExpression: status ? "#s = :s" : undefined,
        ExpressionAttributeNames: { "#m": "month", ...(status && { "#s": "status" }) },
        ExpressionAttributeValues: { ":m": month, ...(status && { ":s": status }) },
        ScanIndexForward: false,
        ExclusiveStartKey,
      }),
    );
    items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function transitionUpdate(orderId, status, detail, source, extra = {}) {
  const from = TRANSITIONS[status];
  if (!from) throw new ValidationError(`status must be one of ${Object.keys(TRANSITIONS).join(", ")}`);
  const timestamp = now();
  const fromValues = Object.fromEntries(from.map((s, i) => [`:from${i}`, s]));
  const extraNames = Object.fromEntries(Object.keys(extra).map((k, i) => [`#x${i}`, k]));
  const extraValues = Object.fromEntries(Object.values(extra).map((v, i) => [`:x${i}`, v]));
  const extraSet = Object.keys(extraNames).map((n, i) => `, ${n} = :x${i}`).join("");
  return {
    TableName: env("ORDERS_TABLE"),
    Key: { order_id: orderId },
    UpdateExpression: `SET #s = :s, updated_at = :t, history = list_append(history, :h)${extraSet}`,
    ConditionExpression: `#s IN (${Object.keys(fromValues).join(", ")})`,
    ExpressionAttributeNames: { "#s": "status", ...extraNames },
    ExpressionAttributeValues: {
      ":s": status,
      ":t": timestamp,
      ":h": [{ status, detail, source, created_at: timestamp }],
      ...fromValues,
      ...extraValues,
    },
  };
}

/** Moves an order to PACKED or SHIPPED, only from the allowed status (see TRANSITIONS). */
export async function setStatus(orderId, status, detail, source, extra) {
  if (status === "CANCELLED") return cancelOrder(orderId, detail, source);
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({ ...transitionUpdate(orderId, status, detail, source, extra), ReturnValues: "ALL_NEW" }),
    );
    console.log(JSON.stringify({ order_id: orderId, status }));
    return Attributes;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") throw new InvalidTransitionError(`order ${orderId} cannot move to ${status}`);
    throw err;
  }
}

/** Cancels an order and puts its items back in stock, atomically. */
export async function cancelOrder(orderId, detail, source) {
  const order = await getOrder(orderId);
  if (!order) throw new InvalidTransitionError(`order ${orderId} cannot move to CANCELLED`);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: transitionUpdate(orderId, "CANCELLED", detail, source) },
          ...order.items.map((l) => ({
            Update: {
              TableName: env("PRODUCTS_TABLE"),
              Key: { id: l.product_id },
              UpdateExpression: "ADD stock :q",
              ConditionExpression: "attribute_exists(id)",
              ExpressionAttributeValues: { ":q": l.quantity },
            },
          })),
        ],
      }),
    );
  } catch (err) {
    if (err.name === "TransactionCanceledException") throw new InvalidTransitionError(`order ${orderId} cannot move to CANCELLED`);
    throw err;
  }
  console.log(JSON.stringify({ order_id: orderId, status: "CANCELLED" }));
  return getOrder(orderId);
}

/** Sets attributes on an existing order (e.g. the packing slip key), without touching its status. */
export async function annotateOrder(orderId, attributes) {
  const names = Object.fromEntries(Object.keys(attributes).map((k, i) => [`#a${i}`, k]));
  const values = Object.fromEntries(Object.values(attributes).map((v, i) => [`:a${i}`, v]));
  await ddb.send(
    new UpdateCommand({
      TableName: env("ORDERS_TABLE"),
      Key: { order_id: orderId },
      UpdateExpression: `SET ${Object.keys(names).map((n, i) => `${n} = :a${i}`).join(", ")}`,
      ConditionExpression: "attribute_exists(order_id)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
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
