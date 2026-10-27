#!/usr/bin/env bash
# End-to-end scenario for solution 1 (EC2). Run from 01-solution-ec2/ after `terraform apply`.
#   1. load balancing  : /api/health answered by several instances / AZs
#   2. catalog         : GET /api/products
#   3. order           : POST /api/orders -> immediate confirmation
#   4. async processing: SNS -> SQS -> worker, status goes PENDING -> PACKING -> SHIPPED
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-$(terraform output -raw base_url)}"
echo "Target: $BASE_URL"

echo -e "\n== 1. Load balancing (6 calls) =="
for _ in $(seq 6); do curl -sf "$BASE_URL/api/health" | jq -c '{instance, az}'; done

echo -e "\n== 2. Catalog =="
curl -sf "$BASE_URL/api/products" | jq -c '.[] | {id, name, price}'

echo -e "\n== 3. Place an order =="
ORDER=$(curl -sf -X POST "$BASE_URL/api/orders" -H 'Content-Type: application/json' -d '{
  "customer_name": "Test Script",
  "customer_email": "test@example.com",
  "items": [{"product_id": "p-001", "quantity": 1}, {"product_id": "p-004", "quantity": 2}]
}')
echo "$ORDER" | jq .
ORDER_ID=$(echo "$ORDER" | jq -r .order_id)

echo -e "\n== 4. Asynchronous processing =="
for _ in $(seq 20); do
  STATUS=$(curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq -r .status)
  echo "status: $STATUS"
  [ "$STATUS" = "SHIPPED" ] && break
  sleep 2
done
curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq '{order_id, status, total, history}'

[ "$STATUS" = "SHIPPED" ] && echo -e "\nPASS" || { echo -e "\nFAIL: order not shipped"; exit 1; }
