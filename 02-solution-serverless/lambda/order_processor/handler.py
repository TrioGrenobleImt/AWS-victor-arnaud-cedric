"""SQS consumer: simulates packing and shipping for each ORDER_PLACED event,
updates the order in DynamoDB and publishes ORDER_SHIPPED (email only)."""
import json
import os
import random
import time
from datetime import datetime, timezone

import boto3

orders_table = boto3.resource("dynamodb").Table(os.environ["ORDERS_TABLE"])
sns = boto3.client("sns")
TOPIC_ARN = os.environ["TOPIC_ARN"]


def set_status(order_id, status, detail, source):
    timestamp = datetime.now(timezone.utc).isoformat()
    orders_table.update_item(
        Key={"order_id": order_id},
        UpdateExpression="SET #s = :s, updated_at = :t, history = list_append(history, :h)",
        ConditionExpression="attribute_exists(order_id)",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": status,
            ":t": timestamp,
            ":h": [{"status": status, "detail": detail, "source": source, "created_at": timestamp}],
        },
    )
    print(json.dumps({"order_id": order_id, "status": status}))


def process(event, source):
    order_id = event["order_id"]
    set_status(order_id, "PACKING", f"packing {sum(i['quantity'] for i in event['items'])} item(s)", source)
    time.sleep(random.uniform(2, 4))
    tracking = f"TRK{random.randint(10**8, 10**9 - 1)}"
    set_status(order_id, "SHIPPED", f"shipped with tracking number {tracking}", source)
    sns.publish(
        TopicArn=TOPIC_ARN,
        Subject=f"Order {order_id[:8]} shipped",
        Message=f"Hello {event['customer_name']},\n\nYour order {order_id} has shipped. Tracking: {tracking}\n",
        MessageAttributes={"event_type": {"DataType": "String", "StringValue": "ORDER_SHIPPED"}},
    )


def handler(event, context):
    failures = []
    for record in event["Records"]:
        try:
            process(json.loads(record["body"]), context.function_name)
        except Exception as exc:  # retried, then sent to the DLQ after 3 attempts
            print(f"failed {record['messageId']}: {exc}")
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
