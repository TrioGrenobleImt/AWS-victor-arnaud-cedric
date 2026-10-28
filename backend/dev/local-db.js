// DynamoDB Local (Docker) for tests and `npm run dev`. Table definitions mirror
// infra/dynamodb.tf.
import { execFileSync } from "node:child_process";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

export const CONTAINER = "fisa-dynamodb-local";
export const PORT = 8001;
export const ENDPOINT = `http://localhost:${PORT}`;

/** Fake credentials + endpoint so the SDK never talks to a real AWS account. Call before importing lib/. */
export function useLocalAws() {
  Object.assign(process.env, {
    AWS_REGION: "eu-west-3",
    AWS_ACCESS_KEY_ID: "local",
    AWS_SECRET_ACCESS_KEY: "local",
    DYNAMODB_ENDPOINT: ENDPOINT,
  });
}

async function reachable(client) {
  try {
    await client.send(new ListTablesCommand({}));
    return true;
  } catch {
    return false;
  }
}

/** Starts the container if needed; returns true when this call started it. */
export async function startDynamoDbLocal() {
  const client = new DynamoDBClient({ endpoint: ENDPOINT, region: "eu-west-3", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  if (await reachable(client)) return false;
  execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", `${PORT}:8000`, "amazon/dynamodb-local", "-jar", "DynamoDBLocal.jar", "-inMemory"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await reachable(client)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("DynamoDB Local did not start (is Docker running?)");
}

export function stopDynamoDbLocal() {
  execFileSync("docker", ["stop", CONTAINER], { stdio: "ignore" });
}

export async function createTables(client, { products, orders }) {
  const throughput = { ReadCapacityUnits: 5, WriteCapacityUnits: 5 };
  await client.send(
    new CreateTableCommand({
      TableName: products,
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      ProvisionedThroughput: throughput,
    }),
  );
  await client.send(
    new CreateTableCommand({
      TableName: orders,
      KeySchema: [{ AttributeName: "order_id", KeyType: "HASH" }],
      AttributeDefinitions: [
        { AttributeName: "order_id", AttributeType: "S" },
        { AttributeName: "month", AttributeType: "S" },
        { AttributeName: "created_at", AttributeType: "S" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "by_month",
          KeySchema: [
            { AttributeName: "month", KeyType: "HASH" },
            { AttributeName: "created_at", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
          ProvisionedThroughput: throughput,
        },
      ],
      ProvisionedThroughput: throughput,
    }),
  );
}

export async function deleteTables(client, tables) {
  await Promise.all(Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))));
}
