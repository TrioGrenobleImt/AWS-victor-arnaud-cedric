import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { after, before, beforeEach } from "node:test";
import { createTables, deleteTables, startDynamoDbLocal } from "../dev/local-db.js";
import { ddb, s3, ses, sns } from "../lib/aws.js";

export const PRODUCTS = [
  { id: "p-001", name: "Midnight Static", artist: "The Velvet Hours", genre: "Indie Rock", price: 27.9, stock: 40 },
  { id: "p-002", name: "Saffron Skies", artist: "Lena Okafor", genre: "Soul", price: 31.5, stock: 3 },
];

// SNS, S3 and SES calls are captured instead of sent.
export const sent = { sns: [], s3: [], ses: [] };
sns.send = async (cmd) => void sent.sns.push(cmd.input);
s3.send = async (cmd) => void sent.s3.push(cmd.input);
ses.send = async (cmd) => void sent.ses.push(cmd.input);

/** Fresh tables for the test file, products re-seeded before each test. */
export function useTables() {
  const client = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
  const tables = { products: process.env.PRODUCTS_TABLE, orders: process.env.ORDERS_TABLE };
  before(async () => {
    await startDynamoDbLocal();
    await createTables(client, tables);
  });
  after(() => deleteTables(client, tables));
  beforeEach(async () => {
    sent.sns.length = 0;
    sent.s3.length = 0;
    sent.ses.length = 0;
    for (const p of PRODUCTS) await ddb.send(new PutCommand({ TableName: tables.products, Item: p }));
  });
}

/** Starts an Express app on a random port; returns its base URL. */
export function serve(app) {
  let server;
  const base = { url: "" };
  before(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base.url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  return base;
}

export const json = (method, body, headers = {}) => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const orderEvent = (published) => JSON.parse(JSON.parse(published.Message).default);
