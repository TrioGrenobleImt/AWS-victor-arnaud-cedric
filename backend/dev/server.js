// `npm run dev`: the whole backend on your machine, no AWS account needed.
//   :8080  shop API (/api/*), admin API (/admin/api/*, token "dev"), /images/*
//   :8090  tiny S3 stand-in (presigned uploads, packing slips), files in .dev-data/
//   DynamoDB Local in Docker, seeded from data/catalog.json; SNS is logged and
//   ORDER_PLACED runs the order-processor Lambda in-process.
import { useLocalAws } from "./local-db.js";

useLocalAws();
Object.assign(process.env, {
  S3_ENDPOINT: "http://localhost:8090",
  PRODUCTS_TABLE: "products",
  ORDERS_TABLE: "orders",
  TOPIC_ARN: "arn:aws:sns:eu-west-3:000000000000:orders",
  IMAGES_BUCKET: "images",
  DOCUMENTS_BUCKET: "documents",
  AUDIT_BUCKET: "audit",
});

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const { dirname, resolve } = await import("node:path");
const { DynamoDBClient, ListTablesCommand } = await import("@aws-sdk/client-dynamodb");
const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
const { default: express } = await import("express");
const { createTables, startDynamoDbLocal } = await import("./local-db.js");
const { ddb, sns } = await import("../lib/aws.js");
const { createApp } = await import("../api/app.js");
const { createAdminApp } = await import("../admin/app.js");
const { handler: processOrders } = await import("../functions/order-processor/index.js");

const ROOT = resolve(import.meta.dirname, "../..");
const STORE = resolve(import.meta.dirname, "../.dev-data");

// --- DynamoDB Local + seed ----------------------------------------------------
await startDynamoDbLocal();
const client = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
const { TableNames } = await client.send(new ListTablesCommand({}));
if (!TableNames.includes("products")) {
  await createTables(client, { products: "products", orders: "orders" });
  const catalog = JSON.parse(await readFile(resolve(ROOT, "data/catalog.json"), "utf8"));
  for (const p of catalog) await ddb.send(new PutCommand({ TableName: "products", Item: p }));
  console.log(`seeded ${catalog.length} products`);
}

// --- SNS: log, and deliver ORDER_PLACED to the processor like SNS -> SQS would --
sns.send = async ({ input }) => {
  const type = input.MessageAttributes.event_type.StringValue;
  console.log(`[sns] ${type}: ${input.Subject}`);
  if (type === "ORDER_PLACED") {
    const body = JSON.parse(input.Message).default;
    setTimeout(() => processOrders({ Records: [{ messageId: "dev", body }] }), 500);
  }
};

// --- S3 stand-in (path-style: /<bucket>/<key>) --------------------------------
const file = (bucket, key) => {
  const path = resolve(STORE, bucket, key);
  if (!path.startsWith(resolve(STORE, bucket) + "/")) throw Object.assign(new Error("bad key"), { status: 400 });
  return path;
};
const save = async (bucket, key, body, type) => {
  const path = file(bucket, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await writeFile(`${path}.type`, type ?? "application/octet-stream");
};
const s3 = express();
s3.use((req, res, next) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,PUT,POST", "Access-Control-Allow-Headers": "*" });
  req.method === "OPTIONS" ? res.sendStatus(204) : next();
});
s3.use(express.raw({ type: () => true, limit: "10mb" }));
s3.put("/:bucket/*key", async (req, res) => {
  await save(req.params.bucket, req.params.key.join("/"), req.body, req.get("content-type"));
  res.sendStatus(200);
});
s3.post("/:bucket", async (req, res) => {
  // Presigned POST: multipart form with the policy fields + the file (signature not checked locally).
  const form = await new Response(req.body, { headers: { "content-type": req.get("content-type") } }).formData();
  const upload = form.get("file");
  await save(req.params.bucket, form.get("key"), Buffer.from(await upload.arrayBuffer()), form.get("Content-Type"));
  res.sendStatus(204);
});
s3.get("/:bucket/*key", async (req, res) => {
  const path = file(req.params.bucket, req.params.key.join("/"));
  try {
    res.type(await readFile(`${path}.type`, "utf8")).send(await readFile(path));
  } catch {
    res.sendStatus(404);
  }
});
s3.listen(8090);

// --- APIs + images ------------------------------------------------------------
const verify = async (token) => {
  if (token !== "dev") throw new Error("invalid token");
  return { username: "dev-admin", groups: ["admins"] };
};
const shop = createApp({ instance: () => ({ instance: "dev", az: "local" }) });
const admin = createAdminApp({ verify });
const app = express();
app.get("/images/*key", async (req, res) => {
  const key = `images/${req.params.key.join("/")}`;
  try {
    res.type(await readFile(`${file("images", key)}.type`, "utf8")).send(await readFile(file("images", key)));
  } catch {
    res.sendFile(resolve(ROOT, key), (err) => err && res.sendStatus(404)); // seed covers from images/
  }
});
app.use((req, res, next) => (req.path.startsWith("/admin/") ? admin : shop)(req, res, next));
app.listen(8080, () => console.log("backend on http://localhost:8080 (admin token: dev), S3 stand-in on :8090"));
