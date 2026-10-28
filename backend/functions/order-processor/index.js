// SQS consumer for ORDER_PLACED events: prepares the warehouse work by writing
// a packing slip to the documents bucket and linking it to the order. Packing
// and shipping are then confirmed by an admin in the back office.
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { env, s3 } from "../../lib/aws.js";
import { annotateOrder } from "../../lib/orders.js";

export function packingSlip({ order_id: orderId, customer_name: name, customer_email: email, items, total }) {
  const width = Math.max(...items.map((i) => i.name.length), 20);
  return [
    "FISA Records — packing slip",
    "",
    `Order    ${orderId}`,
    `Customer ${name} <${email}>`,
    "",
    `${"Qty".padEnd(5)}${"Record".padEnd(width + 2)}Product`,
    ...items.map((i) => `${String(i.quantity).padEnd(5)}${i.name.padEnd(width + 2)}${i.product_id}`),
    "",
    `Items: ${items.reduce((n, i) => n + i.quantity, 0)}    Total: ${Number(total).toFixed(2)} EUR`,
    "",
  ].join("\n");
}

async function processOrder(event) {
  const key = `packing-slips/${event.order_id}.txt`;
  // Plain text on purpose: the slip contains customer input and is opened in a browser.
  await s3.send(
    new PutObjectCommand({ Bucket: env("DOCUMENTS_BUCKET"), Key: key, Body: packingSlip(event), ContentType: "text/plain; charset=utf-8" }),
  );
  await annotateOrder(event.order_id, { packing_slip: key });
  console.log(JSON.stringify({ order_id: event.order_id, packing_slip: key }));
}

export async function handler(event) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    try {
      await processOrder(JSON.parse(record.body));
    } catch (err) {
      // retried, then sent to the DLQ after 3 attempts
      console.error(`failed ${record.messageId}`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
