// Product catalog: read by the shop API, managed by the back office.
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb, env } from "./aws.js";
import { ValidationError, now } from "./orders.js";

export const MAX_STOCK_ADD = 10_000;

export async function listProducts() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: env("PRODUCTS_TABLE"), ExclusiveStartKey }));
    items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getProduct(id) {
  const { Item } = await ddb.send(new GetCommand({ TableName: env("PRODUCTS_TABLE"), Key: { id } }));
  return Item;
}

// Field rules for create (all required except year/image) and update (any subset).
const FIELDS = {
  name: (v) => text(v, "name", 120),
  artist: (v) => text(v, "artist", 120),
  genre: (v) => text(v, "genre", 40),
  description: (v) => text(v, "description", 500),
  year: (v) => {
    const year = Number(v);
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear() + 1) throw new ValidationError("year is invalid");
    return year;
  },
  price: (v) => {
    const price = Math.round(Number(v) * 100) / 100;
    if (!(price >= 0.01 && price <= 10_000)) throw new ValidationError("price must be between 0.01 and 10000");
    return price;
  },
  image: (v) => {
    if (typeof v !== "string" || !/^images\/[\w./-]+$/.test(v) || v.includes("..")) throw new ValidationError("image must be an images/ key");
    return v;
  },
};
const REQUIRED = ["name", "artist", "genre", "description", "price"];

function text(value, field, max) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v.length > max) throw new ValidationError(`${field} is required (max ${max} characters)`);
  return v;
}

function clean(body, required) {
  const out = {};
  for (const [field, check] of Object.entries(FIELDS)) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      if (required.includes(field)) throw new ValidationError(`${field} is required`);
      continue;
    }
    out[field] = check(body[field]);
  }
  return out;
}

export async function createProduct(body) {
  const stock = body.stock === undefined || body.stock === "" ? 0 : Number(body.stock);
  if (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK_ADD) throw new ValidationError(`stock must be between 0 and ${MAX_STOCK_ADD}`);
  const timestamp = now();
  const product = { id: `p-${randomUUID().slice(0, 8)}`, ...clean(body, REQUIRED), stock, created_at: timestamp, updated_at: timestamp };
  await ddb.send(new PutCommand({ TableName: env("PRODUCTS_TABLE"), Item: product, ConditionExpression: "attribute_not_exists(id)" }));
  return product;
}

export async function updateProduct(id, body) {
  const fields = clean(body, []);
  if (!Object.keys(fields).length) throw new ValidationError("nothing to update");
  fields.updated_at = now();
  const names = Object.fromEntries(Object.keys(fields).map((k, i) => [`#f${i}`, k]));
  const values = Object.fromEntries(Object.values(fields).map((v, i) => [`:f${i}`, v]));
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: env("PRODUCTS_TABLE"),
        Key: { id },
        UpdateExpression: `SET ${Object.keys(names).map((n, i) => `${n} = :f${i}`).join(", ")}`,
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return Attributes;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return undefined;
    throw err;
  }
}

/** Atomic restock (ADD), safe while customers are ordering the same product. */
export async function addStock(id, quantity) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_STOCK_ADD) throw new ValidationError(`quantity must be between 1 and ${MAX_STOCK_ADD}`);
  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: env("PRODUCTS_TABLE"),
        Key: { id },
        UpdateExpression: "ADD stock :q SET updated_at = :t",
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeValues: { ":q": qty, ":t": now() },
        ReturnValues: "ALL_NEW",
      }),
    );
    return Attributes;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return undefined;
    throw err;
  }
}
