"""DynamoDB Stream consumer: stores every change of the orders table as a JSON
document in S3 (audit trail / reporting, queryable later with Athena)."""
import json
import os
from datetime import datetime, timezone

import boto3

s3 = boto3.client("s3")
BUCKET = os.environ["AUDIT_BUCKET"]


def handler(event, context):
    for record in event["Records"]:
        ddb = record["dynamodb"]
        order_id = ddb["Keys"]["order_id"]["S"]
        ts = datetime.fromtimestamp(ddb["ApproximateCreationDateTime"], tz=timezone.utc)
        doc = {
            "event_id": record["eventID"],
            "event_name": record["eventName"],  # INSERT | MODIFY | REMOVE
            "order_id": order_id,
            "timestamp": ts.isoformat(),
            "new_image": ddb.get("NewImage"),
            "old_image": ddb.get("OldImage"),
        }
        key = f"orders/dt={ts:%Y-%m-%d}/{order_id}/{ts:%H%M%S}-{record['eventID']}.json"
        s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(doc), ContentType="application/json")
    return {"processed": len(event["Records"])}
