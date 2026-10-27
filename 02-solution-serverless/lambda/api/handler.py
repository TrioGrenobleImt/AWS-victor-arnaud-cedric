"""HTTP API (API Gateway v2 payload): catalog, order placement and tracking.

New orders are written to DynamoDB and an ORDER_PLACED event is published on
SNS, which fans out to the SQS processing queue and to email subscribers.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3

dynamodb = boto3.resource("dynamodb")
sns = boto3.client("sns")
products_table = dynamodb.Table(os.environ["PRODUCTS_TABLE"])
orders_table = dynamodb.Table(os.environ["ORDERS_TABLE"])
TOPIC_ARN = os.environ["TOPIC_ARN"]


def _default(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(type(value))


def response(status, body):
    return {"statusCode": status, "headers": {"Content-Type": "application/json"}, "body": json.dumps(body, default=_default)}


def now():
    return datetime.now(timezone.utc).isoformat()


def health(event):
    return response(200, {"status": "ok", "backend": "serverless", "instance": os.environ["AWS_LAMBDA_FUNCTION_NAME"], "az": os.environ["AWS_REGION"]})


def list_products(event):
    items = products_table.scan()["Items"]
    for item in items:
        item["price"] = float(item["price"])
    return response(200, sorted(items, key=lambda p: p["id"]))


def create_order(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return response(400, {"error": "invalid JSON"})
    name, email, items = body.get("customer_name"), body.get("customer_email"), body.get("items") or []
    if not name or not email or "@" not in email or not items:
        return response(400, {"error": "customer_name, customer_email and items are required"})

    quantities = {}
    for item in items:
        qty = int(item.get("quantity", 0))
        if not 1 <= qty <= 10:
            return response(400, {"error": "quantity must be between 1 and 10"})
        quantities[str(item["product_id"])] = qty

    found = dynamodb.batch_get_item(
        RequestItems={products_table.name: {"Keys": [{"id": pid} for pid in quantities]}}
    )["Responses"][products_table.name]
    found = {p["id"]: p for p in found}
    missing = set(quantities) - set(found)
    if missing:
        return response(400, {"error": f"unknown products: {sorted(missing)}"})

    order_id = str(uuid.uuid4())
    lines = [
        {"product_id": pid, "name": found[pid]["name"], "quantity": qty, "unit_price": found[pid]["price"]}
        for pid, qty in quantities.items()
    ]
    total = sum(line["unit_price"] * line["quantity"] for line in lines)
    timestamp = now()
    orders_table.put_item(Item={
        "order_id": order_id,
        "customer_name": name,
        "customer_email": email,
        "items": lines,
        "total": total,
        "status": "PENDING",
        "created_at": timestamp,
        "updated_at": timestamp,
        "history": [{"status": "PENDING", "detail": "order placed", "source": "api", "created_at": timestamp}],
    })

    event_body = {
        "event_type": "ORDER_PLACED",
        "order_id": order_id,
        "customer_name": name,
        "customer_email": email,
        "total": float(total),
        "items": [{"product_id": l["product_id"], "name": l["name"], "quantity": l["quantity"]} for l in lines],
    }
    text = "\n".join(f"  - {l['quantity']} x {l['name']}" for l in lines)
    sns.publish(
        TopicArn=TOPIC_ARN,
        Subject=f"Order confirmation {order_id[:8]}",
        MessageStructure="json",
        Message=json.dumps({
            "default": json.dumps(event_body),
            "email": f"Hello {name},\n\nThank you for your order {order_id}.\n{text}\nTotal: {float(total):.2f} EUR\n",
        }),
        MessageAttributes={"event_type": {"DataType": "String", "StringValue": "ORDER_PLACED"}},
    )
    return response(201, {
        "order_id": order_id,
        "status": "PENDING",
        "total": float(total),
        "message": f"Thank you {name}! Order {order_id[:8]} confirmed ({float(total):.2f} €). A confirmation has been sent.",
    })


def get_order(event):
    order_id = event["pathParameters"]["id"]
    item = orders_table.get_item(Key={"order_id": order_id}, ConsistentRead=True).get("Item")
    if not item:
        return response(404, {"error": "order not found"})
    return response(200, item)


ROUTES = {
    "GET /api/health": health,
    "GET /api/products": list_products,
    "POST /api/orders": create_order,
    "GET /api/orders/{id}": get_order,
}


def handler(event, context):
    route = ROUTES.get(event.get("routeKey"))
    if not route:
        return response(404, {"error": "not found"})
    return route(event)
