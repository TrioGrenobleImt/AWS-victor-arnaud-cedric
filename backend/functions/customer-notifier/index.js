// SQS consumer for every order event (placed, packed, shipped, cancelled):
// emails the customer through SES. Failed sends go back to the queue, then the DLQ.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env, ses } from "../../lib/aws.js";

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// event_type -> subject and the paragraph that explains the new status
const MESSAGES = {
  ORDER_PLACED: ["Thank you for your order", () => "Thank you for your order. We will let you know as soon as it is packed."],
  ORDER_PACKED: ["Your order is packed", () => "Your order is packed and will ship soon."],
  ORDER_SHIPPED: ["Your order has shipped", (e) => `Your order has shipped.${e.tracking_number ? ` Tracking number: ${e.tracking_number}` : ""}`],
  ORDER_CANCELLED: ["Your order was cancelled", () => "Your order has been cancelled and the items went back to stock."],
};

export function buildEmail(event) {
  const message = MESSAGES[event.event_type];
  if (!message) return null;
  const [subject, paragraph] = message;
  const lines = (event.items ?? []).map((i) => `${i.quantity} x ${i.name}`);
  const total = `Total: ${Number(event.total).toFixed(2)} EUR`;
  const text = [`Hello ${event.customer_name},`, "", paragraph(event), "", `Order ${event.order_id}`, ...lines.map((l) => `  - ${l}`), total, "", "FISA Records", ""].join("\n");
  const html =
    `<p>Hello ${escapeHtml(event.customer_name)},</p><p>${escapeHtml(paragraph(event))}</p>` +
    `<p>Order <code>${escapeHtml(event.order_id)}</code></p><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` +
    `<p>${escapeHtml(total)}</p><p>FISA Records</p>`;
  return { subject: `${subject} (${event.order_id.slice(0, 8)})`, text, html };
}

async function notify(event) {
  const email = buildEmail(event);
  if (!email) return; // not a customer-facing event
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: env("SENDER_EMAIL"),
      Destination: { ToAddresses: [event.customer_email] },
      Content: {
        Simple: {
          Subject: { Data: email.subject, Charset: "UTF-8" },
          Body: { Text: { Data: email.text, Charset: "UTF-8" }, Html: { Data: email.html, Charset: "UTF-8" } },
        },
      },
    }),
  );
  console.log(JSON.stringify({ order_id: event.order_id, event_type: event.event_type, emailed: true }));
}

export async function handler(event) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    try {
      await notify(JSON.parse(record.body));
    } catch (err) {
      console.error(`failed ${record.messageId}`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
