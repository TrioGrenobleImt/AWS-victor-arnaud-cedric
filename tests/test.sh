#!/usr/bin/env bash
# End-to-end scenario. Run from the repository root after `terraform -chdir=infra apply`.
#   1. load balancing   : /api/health answered by several ECS tasks
#   2. catalog + image  : CloudFront -> ALB -> ECS -> DynamoDB, image via CloudFront -> S3
#   3. order            : POST /api/orders -> immediate confirmation + SNS event, stock taken
#   4. async processing : SNS -> SQS -> Lambda writes the packing slip (documents bucket)
#   5. back office      : admin API (Cognito token) moves ORDERED -> PACKED -> SHIPPED
#                         needs ADMIN_EMAIL + ADMIN_PASSWORD of a confirmed admin, skipped otherwise
#   6. validation       : bad order rejected with 400, admin API rejects anonymous calls
set -euo pipefail
cd "$(dirname "$0")/.."

tf() { terraform -chdir=infra output -raw "$1"; }
BASE_URL="${BASE_URL:-$(tf base_url)}"
ADMIN_URL="${ADMIN_URL:-$(tf backoffice_url)}"
ADMIN_URL="${ADMIN_URL%/}"
DOCUMENTS_BUCKET=$(tf documents_bucket)
echo "Storefront: $BASE_URL   Back office: $ADMIN_URL"

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

echo -e "\n== 4. Asynchronous processing: packing slip =="
for _ in $(seq 15); do
  SLIP=$(curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq -r '.packing_slip // empty')
  [ -n "$SLIP" ] && break
  sleep 2
done
echo "packing slip: ${SLIP:-none}"
[ -n "$SLIP" ] && aws s3 cp "s3://$DOCUMENTS_BUCKET/$SLIP" -

echo -e "\n== 5. Back office: ORDERED -> PACKED -> SHIPPED =="
STATUS=$(curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq -r .status)
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id "$(tf user_pool_id)" --client-id "$(tf user_pool_client_id)" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters "USERNAME=$ADMIN_EMAIL,PASSWORD=$ADMIN_PASSWORD" \
    --query AuthenticationResult.AccessToken --output text)
  admin() { curl -sf -X POST "$ADMIN_URL/admin/api/orders/$ORDER_ID/status" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"; }
  admin '{"status": "PACKED"}' | jq -c '{status}'
  admin '{"status": "SHIPPED", "tracking_number": "TEST-123"}' | jq -c '{status, tracking_number}'
  curl -sf "$ADMIN_URL/admin/api/dashboard" -H "Authorization: Bearer $TOKEN" | jq -c '{month, revenue, orders, by_status}'
  STATUS=$(curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq -r .status)
else
  echo "(skipped: set ADMIN_EMAIL and ADMIN_PASSWORD to drive the admin API)"
fi
curl -sf "$BASE_URL/api/orders/$ORDER_ID" | jq '{order_id, status, total, history}'

echo -e "\n== 6. Validation and access control =="
curl -s -o /dev/null -w 'bad order:          HTTP %{http_code}\n' -X POST "$BASE_URL/api/orders" -H 'Content-Type: application/json' -d '{"items": []}'
curl -s -o /dev/null -w 'anonymous admin:    HTTP %{http_code}\n' "$ADMIN_URL/admin/api/orders"
curl -s -o /dev/null -w 'admin via the shop: HTTP %{http_code} (not routed)\n' "$BASE_URL/admin/api/orders"
curl -s -o /dev/null -w 'back office page:   HTTP %{http_code}\n' "$ADMIN_URL/"

EXPECTED=$([ -n "${ADMIN_PASSWORD:-}" ] && echo SHIPPED || echo ORDERED)
[ -n "$SLIP" ] && [ "$STATUS" = "$EXPECTED" ] && echo -e "\nPASS" || { echo -e "\nFAIL: status $STATUS (expected $EXPECTED), packing slip ${SLIP:-missing}"; exit 1; }
