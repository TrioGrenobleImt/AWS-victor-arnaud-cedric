// SQS consumer for every order event (placed, packed, shipped, cancelled):
// emails the customer through SES. Failed sends go back to the queue, then the DLQ.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env, ses } from "../../lib/aws.js";

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const euros = (n) => `${Number(n).toFixed(2)} €`;

// Storefront palette (frontend/src/style.css), inlined because email clients drop <style>.
const C = { bg: "#f3e9dc", paper: "#fffdf9", ink: "#15110e", muted: "#7a6b5d", line: "#eadfce", amber: "#e8a33d", amberInk: "#1d1406", rust: "#d0533a" };
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// event_type -> subject, heading, the paragraph that explains the new status, and the step reached (0 = cancelled)
const MESSAGES = {
  ORDER_PLACED: { subject: "Thank you for your order", heading: (e) => `Thank you, ${firstName(e)}!`, step: 1, paragraph: () => "Your order is confirmed. We will let you know as soon as it is packed." },
  ORDER_PACKED: { subject: "Your order is packed", heading: () => "Your records are packed", step: 2, paragraph: () => "Your order is packed and will ship soon." },
  ORDER_SHIPPED: { subject: "Your order has shipped", heading: () => "Your order is on its way", step: 3, paragraph: () => "Your order has shipped. It should reach you in a few days." },
  ORDER_CANCELLED: { subject: "Your order was cancelled", heading: () => "Your order was cancelled", step: 0, paragraph: () => "Your order has been cancelled. If this is a mistake, simply reply to this email." },
};
const STEPS = ["Ordered", "Packed", "Shipped"];

const firstName = (e) => String(e.customer_name).trim().split(/\s+/)[0];

function progress(step) {
  if (!step) {
    return `<tr><td style="padding:0 40px 28px"><div style="background:#fbe9e4;border-radius:10px;padding:14px 18px;font:600 14px ${SANS};color:${C.rust}">Cancelled · the records are back on the shelf</div></td></tr>`;
  }
  const cells = STEPS.map((label, i) => {
    const done = i < step;
    const dot = `<div style="width:14px;height:14px;border-radius:7px;margin:0 auto 8px;background:${done ? C.amber : C.line}"></div>`;
    return `<td width="33%" align="center" style="font:${done ? 600 : 400} 13px ${SANS};color:${done ? C.ink : C.muted}">${dot}${label}</td>`;
  });
  return `<tr><td style="padding:0 40px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells.join("")}</tr></table></td></tr>`;
}

function itemRows(items) {
  return items
    .map(
      (i) => `<tr>
        <td style="padding:12px 0;border-bottom:1px solid ${C.line};font:15px ${SANS};color:${C.ink}">${escapeHtml(i.name)}<br><span style="font-size:13px;color:${C.muted}">${i.quantity} × ${euros(i.unit_price ?? 0)}</span></td>
        <td align="right" style="padding:12px 0;border-bottom:1px solid ${C.line};font:15px ${SANS};color:${C.ink}">${euros((i.unit_price ?? 0) * i.quantity)}</td>
      </tr>`,
    )
    .join("");
}

function renderHtml(event, message, shopUrl) {
  const ref = escapeHtml(event.order_id.slice(0, 8));
  const tracking = event.event_type === "ORDER_SHIPPED" && event.tracking_number
    ? `<tr><td style="padding:0 40px 28px"><div style="border:1px dashed ${C.amber};border-radius:10px;padding:14px 18px;font:14px ${SANS};color:${C.muted}">Tracking number<br><span style="font:700 18px ${SANS};color:${C.ink};letter-spacing:1px">${escapeHtml(event.tracking_number)}</span></div></td></tr>`
    : "";
  const button = shopUrl
    ? `<tr><td align="center" style="padding:0 40px 36px"><a href="${escapeHtml(shopUrl)}" style="display:inline-block;background:${C.amber};color:${C.amberInk};font:600 15px ${SANS};text-decoration:none;padding:13px 28px;border-radius:999px">Visit the shop</a></td></tr>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(message.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(message.paragraph(event))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.paper};border-radius:16px;overflow:hidden">
    <tr><td style="background:${C.ink};padding:22px 40px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:30px;height:30px;border-radius:15px;background:#0d0b09;border:2px solid #3a322c;text-align:center;vertical-align:middle"><div style="width:10px;height:10px;border-radius:5px;background:${C.amber};margin:0 auto"></div></td>
        <td style="padding-left:12px;font:700 22px ${SERIF};color:#f3e9dc">FISA <span style="color:${C.amber}">Records</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:36px 40px 8px;font:600 12px ${SANS};letter-spacing:2px;text-transform:uppercase;color:#a8661a">Order #${ref}</td></tr>
    <tr><td style="padding:0 40px 12px;font:700 28px/1.2 ${SERIF};color:${C.ink}">${escapeHtml(message.heading(event))}</td></tr>
    <tr><td style="padding:0 40px 28px;font:16px/1.5 ${SANS};color:${C.muted}">${escapeHtml(message.paragraph(event))}</td></tr>
    ${progress(message.step)}
    ${tracking}
    <tr><td style="padding:0 40px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${itemRows(event.items ?? [])}
        <tr><td style="padding:16px 0 0;font:700 16px ${SANS};color:${C.ink}">Total</td><td align="right" style="padding:16px 0 0;font:700 18px ${SANS};color:${C.ink}">${euros(event.total)}</td></tr>
      </table>
    </td></tr>
    ${button}
    <tr><td style="background:#f8f1e7;padding:20px 40px;font:12px/1.5 ${SANS};color:${C.muted}">You receive this email because you ordered from FISA Records.<br>Questions? Simply reply to this email.</td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export function buildEmail(event, shopUrl = process.env.SHOP_URL) {
  const message = MESSAGES[event.event_type];
  if (!message) return null;
  const lines = (event.items ?? []).map((i) => `  - ${i.quantity} x ${i.name}  ${euros((i.unit_price ?? 0) * i.quantity)}`);
  const text = [
    `Hello ${event.customer_name},`,
    "",
    message.paragraph(event),
    ...(event.event_type === "ORDER_SHIPPED" && event.tracking_number ? ["", `Tracking number: ${event.tracking_number}`] : []),
    "",
    `Order #${event.order_id.slice(0, 8)}`,
    ...lines,
    `Total: ${euros(event.total)}`,
    ...(shopUrl ? ["", shopUrl] : []),
    "",
    "FISA Records",
    "",
  ].join("\n");
  return { subject: `${message.subject} (#${event.order_id.slice(0, 8)})`, text, html: renderHtml(event, message, shopUrl) };
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
