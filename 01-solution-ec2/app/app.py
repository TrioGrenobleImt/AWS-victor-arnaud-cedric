"""Web tier: catalog, order placement and order tracking backed by RDS MySQL.

Every new order is stored in MySQL (audit trail in order_events) and an
ORDER_PLACED event is published on SNS, which fans out to the SQS processing
queue (see worker.py) and to the email subscribers.
"""
import json
import os
import time
import uuid
from decimal import Decimal

import boto3
import pymysql
from botocore.config import Config
from flask import Flask, jsonify, redirect, request, send_from_directory

REGION = os.environ["AWS_REGION"]
TOPIC_ARN = os.environ["TOPIC_ARN"]
STATIC_DIR = os.environ.get("STATIC_DIR", "static")
IMAGES_BUCKET = os.environ["IMAGES_BUCKET"]

sns = boto3.client("sns", region_name=REGION)
# Regional endpoint: the global one redirects for buckets outside us-east-1, breaking presigned URLs.
s3 = boto3.client("s3", region_name=REGION, endpoint_url=f"https://s3.{REGION}.amazonaws.com", config=Config(signature_version="s3v4"))
ssm = boto3.client("ssm", region_name=REGION)
DB_PASSWORD = ssm.get_parameter(Name=os.environ["DB_PASSWORD_SSM"], WithDecryption=True)["Parameter"]["Value"]

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(32) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description VARCHAR(1024),
        price DECIMAL(10,2) NOT NULL,
        stock INT NOT NULL,
        artist VARCHAR(255),
        genre VARCHAR(64),
        year SMALLINT,
        image VARCHAR(512))""",
    """CREATE TABLE IF NOT EXISTS orders (
        id CHAR(36) PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        customer_email VARCHAR(255) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)""",
    """CREATE TABLE IF NOT EXISTS order_items (
        order_id CHAR(36) NOT NULL,
        product_id VARCHAR(32) NOT NULL,
        quantity INT NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        PRIMARY KEY (order_id, product_id))""",
    """CREATE TABLE IF NOT EXISTS order_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        order_id CHAR(36) NOT NULL,
        status VARCHAR(20) NOT NULL,
        detail VARCHAR(1024),
        source VARCHAR(64),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (order_id))""",
]

# Columns added after the first release: created on databases that predate them.
PRODUCT_COLUMNS = {
    "artist": "VARCHAR(255)",
    "genre": "VARCHAR(64)",
    "year": "SMALLINT",
    "image": "VARCHAR(512)",
}
PRODUCT_FIELDS = ["id", "name", "description", "price", "stock", *PRODUCT_COLUMNS]


def db():
    return pymysql.connect(
        host=os.environ["DB_HOST"],
        user=os.environ["DB_USER"],
        password=DB_PASSWORD,
        database=os.environ["DB_NAME"],
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=5,
    )


def init_db():
    """Create the schema and sync the catalog (idempotent, retried while RDS boots).

    catalog.json is the source of truth: products are upserted and products
    removed from the file are deleted (order_items keeps its own unit_price).
    """
    with open(os.environ["CATALOG_FILE"]) as f:
        catalog = json.load(f)
    for attempt in range(30):
        try:
            conn = db()
            break
        except pymysql.err.OperationalError:
            time.sleep(10)
    else:
        raise RuntimeError("database unreachable")
    with conn, conn.cursor() as cur:
        for statement in SCHEMA:
            cur.execute(statement)
        cur.execute(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'"
        )
        existing = {r["COLUMN_NAME"] for r in cur.fetchall()}
        for column, ddl in PRODUCT_COLUMNS.items():
            if column not in existing:
                cur.execute(f"ALTER TABLE products ADD COLUMN {column} {ddl}")
        columns = ", ".join(PRODUCT_FIELDS)
        placeholders = ", ".join(["%s"] * len(PRODUCT_FIELDS))
        updates = ", ".join(f"{c} = VALUES({c})" for c in PRODUCT_FIELDS[1:])
        cur.executemany(
            f"INSERT INTO products ({columns}) VALUES ({placeholders}) ON DUPLICATE KEY UPDATE {updates}",
            [tuple(p.get(f) for f in PRODUCT_FIELDS) for p in catalog],
        )
        cur.execute("DELETE FROM products WHERE id NOT IN %s", (tuple(p["id"] for p in catalog),))
        conn.commit()


def to_json(row):
    return {k: float(v) if isinstance(v, Decimal) else (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in row.items()}


init_db()
app = Flask(__name__, static_folder=None)


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html", max_age=0)


@app.get("/<path:filename>")
def static_files(filename):
    """Vite build output (hashed assets/*, favicon...). Unknown paths return 404."""
    return send_from_directory(STATIC_DIR, filename, max_age=31536000 if filename.startswith("assets/") else 3600)


@app.get("/images/<path:key>")
def image(key):
    """Product images stay in the private images bucket: redirect to a short-lived presigned URL."""
    url = s3.generate_presigned_url(
        "get_object", Params={"Bucket": IMAGES_BUCKET, "Key": f"images/{key}"}, ExpiresIn=3600
    )
    return redirect(url, code=302)


@app.get("/api/health")
def health():
    return jsonify(status="ok", backend="ec2", instance=os.environ.get("INSTANCE_ID"), az=os.environ.get("AZ"))


@app.get("/api/products")
def products():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM products ORDER BY id")
        return jsonify([to_json(r) for r in cur.fetchall()])


@app.post("/api/orders")
def create_order():
    body = request.get_json(silent=True) or {}
    name, email, items = body.get("customer_name"), body.get("customer_email"), body.get("items") or []
    if not name or not email or "@" not in email or not items:
        return jsonify(error="customer_name, customer_email and items are required"), 400
    quantities = {}
    for item in items:
        qty = int(item.get("quantity", 0))
        if not 1 <= qty <= 10:
            return jsonify(error="quantity must be between 1 and 10"), 400
        quantities[item["product_id"]] = qty

    order_id = str(uuid.uuid4())
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, name, price FROM products WHERE id IN %s", (tuple(quantities),))
        found = {r["id"]: r for r in cur.fetchall()}
        missing = set(quantities) - set(found)
        if missing:
            return jsonify(error=f"unknown products: {sorted(missing)}"), 400
        total = sum(found[pid]["price"] * qty for pid, qty in quantities.items())
        cur.execute(
            "INSERT INTO orders (id, customer_name, customer_email, total, status) VALUES (%s, %s, %s, %s, 'PENDING')",
            (order_id, name, email, total),
        )
        cur.executemany(
            "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (%s, %s, %s, %s)",
            [(order_id, pid, qty, found[pid]["price"]) for pid, qty in quantities.items()],
        )
        cur.execute(
            "INSERT INTO order_events (order_id, status, detail, source) VALUES (%s, 'PENDING', 'order placed', %s)",
            (order_id, os.environ.get("INSTANCE_ID")),
        )
        conn.commit()

    event = {
        "event_type": "ORDER_PLACED",
        "order_id": order_id,
        "customer_name": name,
        "customer_email": email,
        "total": float(total),
        "items": [{"product_id": pid, "name": found[pid]["name"], "quantity": qty} for pid, qty in quantities.items()],
    }
    lines = "\n".join(f"  - {i['quantity']} x {i['name']}" for i in event["items"])
    sns.publish(
        TopicArn=TOPIC_ARN,
        Subject=f"Order confirmation {order_id[:8]}",
        MessageStructure="json",
        Message=json.dumps({
            "default": json.dumps(event),
            "email": f"Hello {name},\n\nThank you for your order {order_id}.\n{lines}\nTotal: {float(total):.2f} EUR\n",
        }),
        MessageAttributes={"event_type": {"DataType": "String", "StringValue": "ORDER_PLACED"}},
    )
    return jsonify(
        order_id=order_id,
        status="PENDING",
        total=float(total),
        message=f"Thank you {name}! Order {order_id[:8]} confirmed ({float(total):.2f} €). A confirmation has been sent.",
    ), 201


@app.get("/api/orders/<order_id>")
def get_order(order_id):
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM orders WHERE id = %s", (order_id,))
        order = cur.fetchone()
        if not order:
            return jsonify(error="order not found"), 404
        cur.execute("SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = %s", (order_id,))
        items = cur.fetchall()
        cur.execute("SELECT status, detail, source, created_at FROM order_events WHERE order_id = %s ORDER BY id", (order_id,))
        history = cur.fetchall()
    result = to_json(order)
    result["order_id"] = result.pop("id")
    result["items"] = [to_json(i) for i in items]
    result["history"] = [to_json(h) for h in history]
    return jsonify(result)
