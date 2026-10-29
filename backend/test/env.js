// Imported first by every test file: local AWS settings + unique table names,
// set before lib/aws.js creates its clients.
import { useLocalAws } from "../dev/local-db.js";

useLocalAws();
const suffix = Math.random().toString(36).slice(2, 8);
Object.assign(process.env, {
  PRODUCTS_TABLE: `products-${suffix}`,
  ORDERS_TABLE: `orders-${suffix}`,
  TOPIC_ARN: "arn:aws:sns:eu-west-3:000000000000:orders",
  IMAGES_BUCKET: "images",
  DOCUMENTS_BUCKET: "documents",
  SENDER_EMAIL: "shop@example.com",
});
