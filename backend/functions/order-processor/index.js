// SQS consumer: simulates packing and shipping for each ORDER_PLACED event,
// updates the order in DynamoDB and publishes ORDER_SHIPPED (email only).
import { InvalidTransitionError, publish, setStatus } from "../../lib/orders.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min));

async function processOrder(event, source) {
  const { order_id: orderId, customer_name: name, items } = event;
  try {
    await setStatus(orderId, "PACKING", `packing ${items.reduce((n, i) => n + i.quantity, 0)} item(s)`, source);
    await sleep(randomInt(2000, 4000));
    const tracking = `TRK${randomInt(1e8, 1e9)}`;
    await setStatus(orderId, "SHIPPED", `shipped with tracking number ${tracking}`, source);
    await publish(
      "ORDER_SHIPPED",
      `Order ${orderId.slice(0, 8)} shipped`,
      `Hello ${name},\n\nYour order ${orderId} has shipped. Tracking: ${tracking}\n`,
    );
  } catch (err) {
    // Cancelled (or already processed) meanwhile: nothing to do, don't retry.
    if (err instanceof InvalidTransitionError) return console.log(JSON.stringify({ order_id: orderId, skipped: err.message }));
    throw err;
  }
}

export async function handler(event, context) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    try {
      await processOrder(JSON.parse(record.body), context.functionName);
    } catch (err) {
      // retried, then sent to the DLQ after 3 attempts
      console.error(`failed ${record.messageId}`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
