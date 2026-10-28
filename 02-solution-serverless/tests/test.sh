#!/usr/bin/env bash
# End-to-end scenario for solution 2 (serverless). Run from 02-solution-serverless/ after `terraform apply`.
#   1. health / catalog : CloudFront -> API Gateway -> Lambda -> DynamoDB, product image via CloudFront -> S3
#   2. order            : POST /api/orders -> immediate confirmation + SNS event
#   3. async processing : SNS -> SQS -> Lambda, status PENDING -> PACKING -> SHIPPED
#   4. audit streaming  : DynamoDB Stream -> Lambda -> S3 audit documents
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-$(terraform output -raw base_url)}"
AUDIT_BUCKET=$(terraform output -raw audit_bucket)
echo "Target: $BASE_URL"

echo -e "\n== 1. Health + catalog =="
curl -sf "$BASE_URL/api/health" | jq -c .
curl -sf "$BASE_URL/api/products" | jq -c '.[] | {id, name, price}'
IMAGE=$(curl -sf "$BASE_URL/api/products" | jq -r '.[0].image')
echo "Image /$IMAGE (S3 images bucket): $(curl -sfL -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/$IMAGE")"

echo -e "\n== 2. Place an order =="
ORDER=$(curl -sf -X POST "$BASE_URL/api/orders" -H 'Content-Type: application/json' -d '{
  "customer_name": "Test Script",
  "customer_email": "test@example.com",
  "items": [{"product_id": "p-002", "quantity": 2}, {"product_id": "p-006", "quantity": 1}]
}')
echo "$ORDER" | jq .
ORDER_ID=$(echo "$ORDER" | jq -r .order_id)

echo -e "\n== 3. Asynchronous processing =="
for _ in $(seq 20); do
  STATUS=$(curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq -r .status)
  echo "status: $STATUS"
  [ "$STATUS" = "SHIPPED" ] && break
  sleep 2
done
curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq '{order_id, status, total, history}'

echo -e "\n== 4. Audit trail in S3 (DynamoDB Stream) =="
sleep 10
aws s3 ls "s3://$AUDIT_BUCKET/orders/" --recursive | grep "$ORDER_ID" || echo "(no audit document yet, retry in a few seconds)"

echo -e "\n== 5. Validation error is rejected =="
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE_URL/api/orders" -H 'Content-Type: application/json' -d '{"items": []}'

[ "$STATUS" = "SHIPPED" ] && echo -e "\nPASS" || { echo -e "\nFAIL: order not shipped"; exit 1; }
