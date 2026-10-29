"""Generates the architecture diagram (docs/architecture.svg) as a standalone SVG file."""
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


s = Svg(1700, 1030, "FISA Shop — current architecture",
        "ECS on EC2 for the shop and admin APIs, Lambda for event-driven work, CloudFront + S3 for both sites, Cognito, DynamoDB · Terraform · Free Tier")


def line(pts):
    s.parts.append("<path d='" + " ".join(f"{'M' if i == 0 else 'L'}{x},{y}" for i, (x, y) in enumerate(pts))
                   + "' fill='none' stroke='#414d5c' stroke-width='1.6'/>")


# users and edge
s.node(10, 150, 170, 76, "Customers", ["web browser", "optional sign-in"], "user", "USR")
s.node(10, 420, 170, 76, "Back office", ["owner / staff", "hosted login (PKCE)"], "user", "USR")
s.node(190, 130, 210, 96, "CloudFront", ["storefront · HTTPS", "/ /images/* → S3", "/api/* → ALB"], "net", "CF")
s.node(190, 400, 210, 96, "CloudFront", ["back office · HTTPS", "/ /images/* → S3", "/admin/api/* → ALB"], "net", "CF")

s.group(430, 90, 1250, 860, "AWS Cloud · region eu-west-3 (Paris)", "#232F3E", icon="AWS")

# static content
s.node(460, 125, 200, 70, "S3 storefront", ["Vite build · private", "Origin Access Control"], "storage", "S3")
s.node(460, 290, 200, 96, "S3 images", ["product covers", "presigned POST uploads", "shared by both sites"], "storage", "S3")
s.node(460, 455, 200, 70, "S3 back office", ["Vite build · private", "Origin Access Control"], "storage", "S3")

# VPC: ALB + ECS on EC2
s.group(700, 110, 410, 310, "VPC 10.10.0.0/16 · 2 public subnets (2 AZs)", C["net"], icon="VPC")
s.node(720, 180, 370, 66, "Application Load Balancer", ["only reachable from CloudFront · health /api/health"], "net", "ALB")
s.parts.append(f"<rect x='715' y='268' width='380' height='140' fill='none' stroke='{C['compute']}' stroke-width='1.5' stroke-dasharray='6 4'/>")
s.node(725, 300, 178, 84, "shop-api", ["Express · ×2 tasks", "default listener rule", "task role: DDB, SNS"], "compute", "ECS")
s.node(910, 300, 178, 84, "admin-api", ["Express · ×1 task", "/admin/api/* rule", "checks Cognito JWT"], "compute", "ECS")
s.text(905, 400, "ECS cluster on EC2 · ASG t3.micro 1–2", 11.5, C["compute"], "700", "middle")

s.node(1150, 125, 260, 100, "Amazon Cognito", ["customers pool: sign in/up", "admins pool: hosted login", "groups: admins / owners"], "sec", "COG")

# supporting
s.node(460, 610, 200, 84, "Amazon ECR", ["API image (shop + admin)", "scan on push · lifecycle"], "compute", "ECR")
s.node(460, 740, 200, 84, "CloudWatch", ["logs · alarms · dashboard", "DLQ, 5xx, Lambda errors"], "mgmt", "CW")
s.node(460, 860, 200, 70, "Account baseline", ["CloudTrail → S3", "Budgets alert"], "mgmt", "AWS")

# data
s.node(700, 470, 210, 84, "DynamoDB products", ["catalog (back-office owned)", "atomic stock updates"], "db", "DDB")
s.node(950, 470, 210, 96, "DynamoDB orders", ["orders + status history", "by_month · by_customer"], "db", "DDB")
s.node(1210, 470, 210, 70, "SNS order-events", ["topic · encrypted"], "integ", "SNS")
s.node(1450, 470, 210, 70, "Shop owner", ["email subscription", "all order events"], "user", "@")

s.node(950, 740, 210, 84, "S3 documents", ["packing slips · private", "5-min presigned links"], "storage", "S3")
s.node(1210, 610, 210, 84, "SQS order-processing", ["filter: ORDER_PLACED", "DLQ after 3 tries"], "integ", "SQS")
s.node(1210, 740, 210, 96, "order-processor", ["Lambda · batch 5", "writes packing slip,", "links it to the order"], "compute", "λ")
s.node(1450, 610, 210, 84, "SQS customer-emails", ["all 4 order events", "own DLQ + alarm"], "integ", "SQS")
s.node(1450, 740, 210, 84, "customer-notifier", ["Lambda · batch 5", "emails the customer"], "compute", "λ")
s.node(1450, 860, 210, 70, "Amazon SES", ["sender identity"], "integ", "SES")

# edge flow
s.arrow([(180, 188), (190, 188)])
s.arrow([(180, 458), (190, 458)])
s.arrow([(400, 160), (460, 160)], "/", at=(430, 148))
s.arrow([(400, 205), (720, 205)], "/api/*", at=(560, 205))
s.arrow([(400, 222), (430, 222), (430, 325), (460, 325)], "/images/*", at=(430, 275))
s.arrow([(400, 470), (460, 470)], "/", at=(430, 458))
s.arrow([(400, 440), (445, 440), (445, 365), (460, 365)])
s.arrow([(400, 410), (670, 410), (670, 230), (720, 230)], "/admin/api/*", at=(540, 410))
s.arrow([(1095, 330), (1125, 330), (1125, 200), (1150, 200)], "verify JWT", dashed=True, at=(1125, 265))
s.arrow([(660, 645), (690, 645), (690, 340), (715, 340)], dashed=True)

# ALB -> services
s.arrow([(812, 246), (812, 300)], "/api/*", at=(812, 276))
s.arrow([(997, 246), (997, 300)], "/admin/api/*", at=(997, 276))

# services -> data and events (shared bus)
line([(760, 384), (760, 445)])
line([(1020, 384), (1020, 445)])
line([(760, 445), (1315, 445)])
s.arrow([(805, 445), (805, 470)])
s.arrow([(1055, 445), (1055, 470)])
s.arrow([(1315, 445), (1315, 470)])
s.label(900, 445, "read / write")
s.label(1215, 445, "publish events")

# event pipeline
s.arrow([(1420, 505), (1450, 505)])
s.arrow([(1280, 540), (1280, 610)], "ORDER_PLACED", at=(1280, 575))
s.arrow([(1400, 540), (1400, 575), (1555, 575), (1555, 610)], "all events", at=(1480, 575))
s.arrow([(1315, 694), (1315, 740)])
s.arrow([(1555, 694), (1555, 740)])
s.arrow([(1555, 824), (1555, 860)])
s.arrow([(1210, 800), (1160, 800)])
s.arrow([(1210, 755), (1185, 755), (1185, 515), (1160, 515)], dashed=True)

s.badge(685, 205, 1)
s.badge(1330, 458, 2)
s.badge(1331, 718, 3)
s.badge(1572, 842, 4)
s.legend(1000, ["Browse & order via CloudFront", "Order stored, event published", "Queue → packing slip",
                "Customer email via SES"])
s.save("architecture.svg")
print("ok")
