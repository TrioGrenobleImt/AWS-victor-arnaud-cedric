// DynamoDB Stream consumer: stores every change of the orders table as a JSON
// document in S3 (audit trail / reporting, queryable later with Athena).
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { env, s3 } from "../../lib/aws.js";

export async function handler(event) {
  for (const record of event.Records) {
    const { Keys, ApproximateCreationDateTime, NewImage, OldImage } = record.dynamodb;
    const orderId = Keys.order_id.S;
    const ts = new Date(ApproximateCreationDateTime * 1000).toISOString();
    const doc = {
      event_id: record.eventID,
      event_name: record.eventName, // INSERT | MODIFY | REMOVE
      order_id: orderId,
      timestamp: ts,
      new_image: NewImage,
      old_image: OldImage,
    };
    const key = `orders/dt=${ts.slice(0, 10)}/${orderId}/${ts.slice(11, 19).replaceAll(":", "")}-${record.eventID}.json`;
    await s3.send(
      new PutObjectCommand({ Bucket: env("AUDIT_BUCKET"), Key: key, Body: JSON.stringify(doc), ContentType: "application/json" }),
    );
  }
  return { processed: event.Records.length };
}
