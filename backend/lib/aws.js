// AWS SDK v3 clients shared by the API (ECS) and the Lambda functions.
// The Lambda Node.js runtime ships the SDK, so functions bundle only their own code + lib/.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SNSClient } from "@aws-sdk/client-sns";

// DYNAMODB_ENDPOINT points at DynamoDB Local for tests / local development.
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT }), {
  marshallOptions: { removeUndefinedValues: true },
});
export const sns = new SNSClient({});
export const ses = new SESv2Client({});
// S3_ENDPOINT points at the local S3 stand-in of `npm run dev` (path-style URLs).
export const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: Boolean(process.env.S3_ENDPOINT) });

export function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}
