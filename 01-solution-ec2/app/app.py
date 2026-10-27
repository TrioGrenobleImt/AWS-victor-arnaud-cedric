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
from flask import Flask, jsonify, request, send_from_directory

REGION = os.environ["AWS_REGION"]
TOPIC_ARN = os.environ["TOPIC_ARN"]
STATIC_DIR = os.environ.get("STATIC_DIR", "static")

sns = boto3.client("sns", region_name=REGION)
ssm = boto3.client("ssm", region_name=REGION)
DB_PASSWORD = ssm.get_parameter(Name=os.environ["DB_PASSWORD_SSM"], WithDecryption=True)["Parameter"]["Value"]

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(32) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description VARCHAR(1024),
        price DECIMAL(10,2) NOT NULL,
        stock INT NOT NULL)""",
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
    """Create the schema and seed the catalog (idempotent, retried while RDS boots)."""
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
        for p in catalog:
            cur.execute(
                "INSERT IGNORE INTO products (id, name, description, price, stock) VALUES (%s, %s, %s, %s, %s)",
                (p["id"], p["name"], p["description"], p["price"], p["stock"]),
            )
        conn.commit()


def to_json(row):
    return {k: float(v) if isinstance(v, Decimal) else (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in row.items()}


init_db()
app = Flask(__name__, static_folder=None)


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


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
