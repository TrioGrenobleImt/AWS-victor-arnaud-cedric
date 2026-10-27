"""Generates the two architecture diagrams as standalone SVG files."""
import sys
from html import escape

OUT = sys.argv[1]

# AWS architecture icon category colours
C = {
    "compute": "#ED7100", "storage": "#7AA116", "db": "#C925D1", "net": "#8C4FFF",
    "integ": "#E7157B", "mgmt": "#E7157B", "sec": "#DD344C", "user": "#232F3E",
}
FONT = "font-family='Helvetica, Arial, sans-serif'"


class Svg:
    def __init__(self, w, h, title, subtitle):
        self.w, self.h = w, h
        self.parts = [
            f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' width='{w}' height='{h}' {FONT}>",
            "<defs>"
            "<marker id='a' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'>"
            "<path d='M0,0 L10,5 L0,10 z' fill='#414d5c'/></marker>"
            "<marker id='ad' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'>"
            "<path d='M0,0 L10,5 L0,10 z' fill='#8d99a8'/></marker>"
            "</defs>",
            f"<rect width='{w}' height='{h}' fill='#ffffff'/>",
            f"<text x='30' y='42' font-size='24' font-weight='700' fill='#16191f'>{escape(title)}</text>",
            f"<text x='30' y='66' font-size='14' fill='#5f6b7a'>{escape(subtitle)}</text>",
        ]
        self.labels = []  # drawn last so they sit on top of arrows

    def group(self, x, y, w, h, label, color, fill="none", dash=None, icon=None):
        d = f" stroke-dasharray='{dash}'" if dash else ""
        self.parts.append(f"<rect x='{x}' y='{y}' width='{w}' height='{h}' fill='{fill}' stroke='{color}' stroke-width='1.5'{d}/>")
        tx = x + 10
        if icon:
            self.parts.append(f"<rect x='{x}' y='{y}' width='26' height='26' fill='{color}'/>"
                              f"<text x='{x+13}' y='{y+17}' font-size='10' font-weight='700' fill='#fff' text-anchor='middle'>{icon}</text>")
            tx = x + 34
        self.parts.append(f"<text x='{tx}' y='{y+18}' font-size='13' font-weight='700' fill='{color}'>{escape(label)}</text>")

    def node(self, x, y, w, h, title, lines, cat, abbr, dashed=False):
        color = C[cat]
        d = " stroke-dasharray='6 4'" if dashed else ""
        op = " opacity='0.55'" if dashed else ""
        self.parts.append(f"<g{op}><rect x='{x}' y='{y}' width='{w}' height='{h}' rx='6' fill='#fff' stroke='{color}' stroke-width='1.6'{d}/>"
                          f"<rect x='{x+10}' y='{y+12}' width='34' height='34' rx='4' fill='{color}'/>"
                          f"<text x='{x+27}' y='{y+33}' font-size='10.5' font-weight='700' fill='#fff' text-anchor='middle'>{abbr}</text>"
                          f"<text x='{x+52}' y='{y+26}' font-size='13.5' font-weight='700' fill='#16191f'>{escape(title)}</text>")
        for i, line in enumerate(lines):
            self.parts.append(f"<text x='{x+52}' y='{y+43+i*15}' font-size='11.5' fill='#5f6b7a'>{escape(line)}</text>")
        self.parts.append("</g>")

    def arrow(self, pts, label=None, at=None, dashed=False, both=False):
        path = " ".join(f"{'M' if i == 0 else 'L'}{x},{y}" for i, (x, y) in enumerate(pts))
        color, marker = ("#8d99a8", "ad") if dashed else ("#414d5c", "a")
        d = " stroke-dasharray='6 4'" if dashed else ""
        start = f" marker-start='url(#{marker})'" if both else ""
        self.parts.append(f"<path d='{path}' fill='none' stroke='{color}' stroke-width='1.6'{d}{start} marker-end='url(#{marker})'/>")
        if label:
            if at is None:
                (x1, y1), (x2, y2) = pts[0], pts[1]
                at = ((x1 + x2) / 2, (y1 + y2) / 2)
            self.label(at[0], at[1], label)

    def label(self, x, y, text, size=11):
        w = len(text) * size * 0.56 + 10
        self.labels.append(f"<rect x='{x-w/2}' y='{y-9}' width='{w}' height='17' rx='3' fill='#fff' stroke='#d5dbe1'/>"
                           f"<text x='{x}' y='{y+4}' font-size='{size}' fill='#414d5c' text-anchor='middle'>{escape(text)}</text>")

    def badge(self, x, y, n):
        self.labels.append(f"<circle cx='{x}' cy='{y}' r='10' fill='#232F3E'/>"
                           f"<text x='{x}' y='{y+4}' font-size='11' font-weight='700' fill='#fff' text-anchor='middle'>{n}</text>")

    def text(self, x, y, s, size=12, color="#414d5c", weight="400", anchor="start"):
        self.parts.append(f"<text x='{x}' y='{y}' font-size='{size}' font-weight='{weight}' fill='{color}' text-anchor='{anchor}'>{escape(s)}</text>")

    def legend(self, y, steps):
        self.parts.append(f"<line x1='30' y1='{y-18}' x2='{self.w-30}' y2='{y-18}' stroke='#e9ebed'/>")
        x = 30
        for i, s in enumerate(steps, 1):
            self.badge(x + 10, y, i)
            self.text(x + 26, y + 4, s, 12)
            x += 30 + len(s) * 6.6
        self.parts.append(f"<path d='M{self.w-330},{y} L{self.w-290},{y}' stroke='#414d5c' stroke-width='1.6' marker-end='url(#a)'/>")
        self.text(self.w - 282, y + 4, "request / event", 12)
        self.parts.append(f"<path d='M{self.w-170},{y} L{self.w-130},{y}' stroke='#8d99a8' stroke-width='1.6' stroke-dasharray='6 4' marker-end='url(#ad)'/>")
        self.text(self.w - 122, y + 4, "config / optional", 12)

    def save(self, name):
        with open(f"{OUT}/{name}", "w") as f:
            f.write("\n".join(self.parts + self.labels + ["</svg>"]))


# ----------------------------------------------------------------- Solution 1
s = Svg(1400, 900, "Solution 1 — EC2 (virtual machines)",
        "Online shop on an Auto Scaling group behind an Application Load Balancer, RDS MySQL, SNS → SQS order processing · Terraform · Free Tier")

s.node(40, 180, 140, 66, "Customers", ["web browser"], "user", "USR")
s.group(210, 90, 1170, 740, "AWS Cloud · region eu-west-3 (Paris)", "#232F3E", icon="AWS")
s.group(240, 135, 640, 680, "VPC 10.10.0.0/16", C["net"], icon="VPC")
# Internet gateway on the VPC edge
s.parts.append(f"<rect x='226' y='196' width='28' height='28' rx='4' fill='{C['net']}'/>"
               "<text x='240' y='214' font-size='9' font-weight='700' fill='#fff' text-anchor='middle'>IGW</text>")

for i, az in enumerate(["a", "b"]):
    x = 265 + i * 300
    s.group(x, 270, 285, 530, f"Availability Zone eu-west-3{az}", "#147EBA", dash="8 5")
    s.group(x + 12, 300, 261, 236, f"Public subnet 10.10.{i}.0/24", "#7AA116", fill="#F2F8F0")
    s.group(x + 12, 556, 261, 232, f"Private subnet 10.10.{10+i}.0/24", "#147EBA", fill="#E6F2F8")

s.node(285, 168, 570, 66, "Application Load Balancer", ["HTTP :80 · health check /api/health · spans both AZs"], "net", "ALB")
s.parts.append(f"<rect x='285' y='338' width='570' height='186' fill='none' stroke='{C['compute']}' stroke-width='1.5' stroke-dasharray='6 4'/>")
s.text(295, 517, "Auto Scaling group", 13, C["compute"], "700")
s.text(592, 517, "min 2 · max 3 · CPU 60 %", 12, C["compute"], "700")
ec2_lines = ["Amazon Linux 2023 · IMDSv2", "gunicorn Flask API :8080", "worker: SQS consumer", "IAM instance profile"]
s.node(297, 350, 236, 112, "EC2 t3.micro", ec2_lines, "compute", "EC2")
s.node(597, 350, 236, 112, "EC2 t3.micro", ec2_lines, "compute", "EC2")
s.node(297, 600, 236, 112, "RDS MySQL 8.0", ["db.t4g.micro · single-AZ", "20 GB gp2 · encrypted (KMS)", "orders, order_items,", "order_events (audit)"], "db", "RDS")
s.node(597, 600, 236, 112, "RDS standby", ["Multi-AZ (sync replica)", "disabled: not in Free Tier", "db_multi_az = true"], "db", "RDS", dashed=True)

# Right-hand managed services
s.node(925, 200, 200, 70, "Amazon SNS", ["topic order-events", "encrypted (aws/sns)"], "integ", "SNS")
s.node(1165, 200, 190, 70, "Email subscribers", ["order confirmed / shipped"], "user", "@")
s.node(925, 400, 200, 70, "Amazon SQS", ["order-processing", "long polling 20 s"], "integ", "SQS")
s.node(1165, 400, 190, 70, "Dead-letter queue", ["after 3 failed attempts"], "integ", "DLQ")
s.group(912, 530, 455, 112, "Instance bootstrap (user data)", "#5f6b7a", dash="6 4")
s.node(925, 560, 200, 70, "Amazon S3", ["app code, catalog, frontend", "versioned releases"], "storage", "S3")
s.node(1155, 560, 200, 70, "SSM Parameter Store", ["DB password", "SecureString"], "mgmt", "SSM")
s.node(925, 690, 200, 80, "Amazon CloudWatch", ["metrics ALB/ASG/RDS/SQS", "4 alarms · dashboard"], "mgmt", "CW")
s.node(1165, 690, 190, 80, "SNS alerts topic", ["→ email (ops)"], "integ", "SNS")
s.text(925, 790, "Security groups: ALB → app :8080 → DB :3306 · no SSH (SSM)", 11, "#5f6b7a")
s.text(925, 806, "Account baseline: AWS Budgets (1 USD alert) · CloudTrail → S3", 11, "#5f6b7a")

s.arrow([(180, 210), (226, 210)], "HTTP", at=(203, 196))
s.arrow([(254, 210), (285, 210)])
s.arrow([(510, 234), (510, 350)], ":8080", at=(510, 252))
s.arrow([(810, 234), (810, 350)], ":8080", at=(810, 252))
s.arrow([(510, 462), (510, 600)], "MySQL 3306", at=(510, 486))
s.arrow([(790, 462), (790, 546), (557, 546), (557, 630), (533, 630)])
s.arrow([(533, 680), (597, 680)], dashed=True)
s.arrow([(855, 380), (905, 380), (905, 235), (925, 235)], "publish", at=(906, 310))
s.arrow([(1125, 235), (1165, 235)])
s.arrow([(1025, 270), (1025, 400)], "filter: ORDER_PLACED", at=(1025, 335))
s.arrow([(925, 445), (855, 445)], "poll", at=(890, 445))
s.arrow([(1125, 435), (1165, 435)])
s.arrow([(912, 586), (868, 586), (868, 500), (855, 500)], dashed=True)
s.arrow([(1125, 730), (1165, 730)])
s.badge(195, 180, 1)
s.badge(912, 380, 2)
s.badge(1138, 222, 3)
s.badge(1038, 380, 4)
s.badge(523, 600, 5)
s.legend(865, ["Browse & order via ALB", "Store order + publish event", "Email confirmation",
               "Worker packs & ships", "Audit trail in RDS"])
s.save("architecture-solution-1-ec2.svg")

# ----------------------------------------------------------------- Solution 2
s = Svg(1400, 860, "Solution 2 — Serverless",
        "Static site on S3 + CloudFront, API Gateway + Lambda, DynamoDB with Streams, SNS → SQS order processing · Terraform · Free Tier")

s.node(20, 345, 130, 66, "Customers", ["web browser"], "user", "USR")
s.node(178, 330, 205, 96, "Amazon CloudFront", ["global edge · HTTPS", "PriceClass_100", "/ → S3 · /api/* → API"], "net", "CF")
s.group(400, 90, 975, 700, "AWS Cloud · region eu-west-3 (Paris) — every service is managed and multi-AZ", "#232F3E", icon="AWS")

s.node(430, 140, 200, 70, "S3 website bucket", ["index.html · private", "Origin Access Control"], "storage", "S3")
s.node(430, 340, 200, 70, "API Gateway", ["HTTP API · $default", "throttle 10 rps / burst 20"], "net", "API")
s.node(680, 340, 200, 70, "Lambda api", ["python3.12 · arm64", "routes /api/*"], "compute", "λ")
s.node(930, 200, 200, 70, "DynamoDB products", ["catalog · 5 RCU / 5 WCU"], "db", "DDB")
s.node(930, 340, 200, 70, "DynamoDB orders", ["orders + status history", "stream NEW_AND_OLD"], "db", "DDB")
s.node(680, 500, 200, 70, "Amazon SNS", ["topic order-events"], "integ", "SNS")
s.node(430, 500, 200, 70, "Email subscribers", ["order confirmed / shipped"], "user", "@")
s.node(680, 660, 200, 70, "Amazon SQS", ["order-processing"], "integ", "SQS")
s.node(430, 660, 200, 70, "Dead-letter queue", ["after 3 failed attempts"], "integ", "DLQ")
s.node(930, 660, 200, 70, "Lambda processor", ["order_processor", "packing → shipping"], "compute", "λ")
s.node(1160, 340, 195, 70, "Lambda audit", ["audit_stream", "stream consumer"], "compute", "λ")
s.node(1160, 500, 195, 70, "S3 audit bucket", ["1 JSON doc per change", "versioned · 90 d lifecycle"], "storage", "S3")
s.node(1160, 660, 195, 70, "Amazon Athena", ["SQL reporting (proposed)"], "storage", "ATH", dashed=True)
s.node(1160, 120, 195, 70, "CloudWatch · X-Ray", ["logs 7 d · 5 alarms", "dashboard · traces"], "mgmt", "CW")
s.node(1160, 210, 195, 70, "IAM", ["1 least-privilege role", "per Lambda function"], "sec", "IAM")
s.text(430, 770, "Account baseline: AWS Budgets (1 USD alert) · CloudTrail → S3 · encryption with AWS managed / owned keys", 11, "#5f6b7a")

s.arrow([(150, 378), (178, 378)])
s.arrow([(280, 330), (280, 175), (430, 175)], "/ (static, cached)", at=(330, 175))
s.arrow([(383, 375), (430, 375)], "/api/*", at=(407, 360))
s.arrow([(630, 375), (680, 375)])
s.arrow([(880, 360), (905, 360), (905, 235), (930, 235)], "read catalog", at=(905, 300))
s.arrow([(880, 390), (930, 390)], "put order", at=(905, 404))
s.arrow([(780, 410), (780, 500)], "publish ORDER_PLACED", at=(780, 455))
s.arrow([(680, 535), (630, 535)])
s.arrow([(780, 570), (780, 660)], "filter: ORDER_PLACED", at=(780, 615))
s.arrow([(680, 695), (630, 695)])
s.arrow([(880, 695), (930, 695)], "trigger", at=(905, 681))
s.arrow([(1050, 660), (1050, 410)], "status PACKING → SHIPPED", at=(1050, 470))
s.arrow([(960, 660), (960, 545), (880, 545)], "ORDER_SHIPPED", at=(960, 600))
s.arrow([(1130, 375), (1160, 375)], "stream", at=(1145, 361))
s.arrow([(1257, 410), (1257, 500)])
s.arrow([(1257, 570), (1257, 660)], dashed=True)
s.badge(164, 360, 1)
s.badge(793, 425, 2)
s.badge(655, 520, 3)
s.badge(918, 722, 4)
s.badge(1270, 425, 5)
s.legend(825, ["Browse & order via CloudFront", "Store order + publish event", "Email confirmation",
               "Lambda packs & ships", "Audit stream to S3"])
s.save("architecture-solution-2-serverless.svg")
print("ok")
