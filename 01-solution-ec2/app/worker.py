"""Order processing worker: consumes ORDER_PLACED events from SQS, simulates
packing and shipping, records each step in order_events (audit) and publishes
an ORDER_SHIPPED event on SNS (delivered to email subscribers only)."""
import json
import os
import random
import time

import boto3
import pymysql

REGION = os.environ["AWS_REGION"]
QUEUE_URL = os.environ["QUEUE_URL"]
TOPIC_ARN = os.environ["TOPIC_ARN"]
INSTANCE_ID = os.environ.get("INSTANCE_ID")

sqs = boto3.client("sqs", region_name=REGION)
sns = boto3.client("sns", region_name=REGION)
ssm = boto3.client("ssm", region_name=REGION)
DB_PASSWORD = ssm.get_parameter(Name=os.environ["DB_PASSWORD_SSM"], WithDecryption=True)["Parameter"]["Value"]


def db():
    return pymysql.connect(
        host=os.environ["DB_HOST"],
        user=os.environ["DB_USER"],
        password=DB_PASSWORD,
        database=os.environ["DB_NAME"],
        connect_timeout=5,
    )


def set_status(order_id, status, detail):
    with db() as conn, conn.cursor() as cur:
        cur.execute("UPDATE orders SET status = %s WHERE id = %s", (status, order_id))
        cur.execute(
            "INSERT INTO order_events (order_id, status, detail, source) VALUES (%s, %s, %s, %s)",
            (order_id, status, detail, INSTANCE_ID),
        )
        conn.commit()
    print(f"order {order_id} -> {status}", flush=True)


def process(event):
    order_id = event["order_id"]
    set_status(order_id, "PACKING", f"packing {sum(i['quantity'] for i in event['items'])} item(s)")
    time.sleep(random.uniform(2, 4))
    tracking = f"TRK{random.randint(10**8, 10**9 - 1)}"
    set_status(order_id, "SHIPPED", f"shipped with tracking number {tracking}")
    sns.publish(
        TopicArn=TOPIC_ARN,
        Subject=f"Order {order_id[:8]} shipped",
        Message=f"Hello {event['customer_name']},\n\nYour order {order_id} has shipped. Tracking: {tracking}\n",
        MessageAttributes={"event_type": {"DataType": "String", "StringValue": "ORDER_SHIPPED"}},
    )


def main():
    print("worker started", flush=True)
    while True:
        resp = sqs.receive_message(QueueUrl=QUEUE_URL, MaxNumberOfMessages=5, WaitTimeSeconds=20)
        for msg in resp.get("Messages", []):
            try:
                process(json.loads(msg["Body"]))
                sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=msg["ReceiptHandle"])
            except Exception as exc:  # message becomes visible again, then goes to the DLQ
                print(f"failed to process message {msg['MessageId']}: {exc}", flush=True)


if __name__ == "__main__":
    main()
