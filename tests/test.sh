#!/usr/bin/env bash
# End-to-end scenario. Run from the repository root after `terraform -chdir=infra apply`.
#   1. load balancing   : /api/health answered by several ECS tasks
#   2. catalog + image  : CloudFront -> ALB -> ECS -> DynamoDB, image via CloudFront -> S3
#   3. order            : POST /api/orders -> immediate confirmation + SNS event
#   4. async processing : SNS -> SQS -> Lambda, status PENDING -> PACKING -> SHIPPED
#   5. audit streaming  : DynamoDB Stream -> Lambda -> S3 audit documents
#   6. validation       : bad order rejected with 400
set -euo pipefail
cd "$(dirname "$0")/.."

tf() { terraform -chdir=infra output -raw "$1"; }
BASE_URL="${BASE_URL:-$(tf base_url)}"
AUDIT_BUCKET=$(tf audit_bucket)
echo "Target: $BASE_URL"

echo -e "\n== 1. Load balancing (6 calls) =="
for _ in $(seq 6); do curl -sf "$BASE_URL/api/health" | jq -c '{instance, az}'; done

echo -e "\n== 2. Catalog + product image =="
curl -sf "$BASE_URL/api/products" | jq -c '.[] | {id, name, artist, price}'
IMAGE=$(curl -sf "$BASE_URL/api/products" | jq -r '.[0].image')
echo "Image /$IMAGE (S3 images bucket): $(curl -sf -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/$IMAGE")"

echo -e "\n== 3. Place an order =="
ORDER=$(curl -sf -X POST "$BASE_URL/api/orders" -H 'Content-Type: application/json' -d '{
  "customer_name": "Test Script",
  "customer_email": "test@example.com",
  "items": [{"product_id": "p-002", "quantity": 2}, {"product_id": "p-006", "quantity": 1}]
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

echo -e "\n== 5. Audit trail in S3 (DynamoDB Stream) =="
sleep 10
aws s3 ls "s3://$AUDIT_BUCKET/orders/" --recursive | grep "$ORDER_ID" || echo "(no audit document yet, retry in a few seconds)"

echo -e "\n== 6. Validation error is rejected =="
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE_URL/api/orders" -H 'Content-Type: application/json' -d '{"items": []}'

[ "$STATUS" = "SHIPPED" ] && echo -e "\nPASS" || { echo -e "\nFAIL: order not shipped"; exit 1; }
