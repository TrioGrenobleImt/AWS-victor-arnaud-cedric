"""Generates one original album cover (SVG) per catalog entry into covers/.

The covers are uploaded to the images S3 bucket of each solution by Terraform
(key = the product's "image" field). Replace any file with a real JPG/PNG/WebP
and update "image" in catalog.json to use your own artwork.
"""
import json
import math
import random
from html import escape
from pathlib import Path

HERE = Path(__file__).parent
CATALOG = json.loads((HERE.parent / "catalog.json").read_text())
SIZE = 600

# Per-album palette (background, primary, secondary, text) and pattern
STYLES = {
    "p-001": ("#141428", "#e94f64", "#f6d6ad", "#f6d6ad", "rings"),
    "p-002": ("#f2a541", "#b23a48", "#fbe7c6", "#2b1a12", "sun"),
    "p-003": ("#0f2a47", "#4f9ad8", "#e8eef4", "#e8eef4", "bars"),
    "p-004": ("#1a0b2e", "#ff2e97", "#29e7cd", "#ffffff", "grid"),
    "p-005": ("#d9c6a5", "#7a4b2a", "#3e5641", "#2b1d12", "hills"),
    "p-006": ("#0b3c49", "#7fd1c7", "#d7f2ee", "#d7f2ee", "waves"),
    "p-007": ("#e6e1d8", "#1c1c1c", "#e84a27", "#1c1c1c", "blocks"),
    "p-008": ("#3b1f0e", "#f0a202", "#d95d39", "#f7e2b6", "stripes"),
}


def pattern(kind, primary, secondary, rng):
    s, c = SIZE, SIZE / 2
    out = []
    if kind == "rings":
        for i, r in enumerate(range(260, 20, -30)):
            out.append(f"<circle cx='{c}' cy='{c - 40}' r='{r}' fill='none' stroke='{primary if i % 2 else secondary}' stroke-width='12' opacity='{0.35 + i * 0.07:.2f}'/>")
    elif kind == "sun":
        out.append(f"<circle cx='{c}' cy='{c - 30}' r='170' fill='{primary}'/>")
        for i in range(7):
            y = c - 30 + 30 + i * 22
            out.append(f"<rect x='0' y='{y}' width='{s}' height='{6 + i * 2}' fill='{secondary}'/>")
    elif kind == "bars":
        x = 40
        while x < s - 40:
            w = rng.choice([8, 14, 24, 40])
            h = rng.randint(120, 380)
            out.append(f"<rect x='{x}' y='{360 - h}' width='{w}' height='{h}' fill='{rng.choice([primary, secondary])}' opacity='0.9'/>")
            x += w + rng.choice([6, 10, 18])
    elif kind == "grid":
        out.append(f"<circle cx='{c}' cy='230' r='130' fill='{primary}'/>")
        for i in range(6):
            out.append(f"<rect x='{c - 130}' y='{240 + i * 20}' width='260' height='{4 + i}' fill='#1a0b2e'/>")
        for i in range(12):
            y = 330 + i * i * 2.4
            out.append(f"<line x1='0' y1='{y:.1f}' x2='{s}' y2='{y:.1f}' stroke='{secondary}' stroke-width='2'/>")
        for i in range(-10, 11):
            out.append(f"<line x1='{c + i * 12}' y1='330' x2='{c + i * 90}' y2='{s}' stroke='{secondary}' stroke-width='2'/>")
    elif kind == "hills":
        out.append(f"<circle cx='430' cy='170' r='70' fill='{secondary}' opacity='0.8'/>")
        for i, color in enumerate([primary, secondary, primary]):
            base = 300 + i * 70
            pts = " ".join(f"{x},{base - 50 * math.sin(x / (90 + i * 25) + i):.1f}" for x in range(0, s + 20, 20))
            out.append(f"<polygon points='0,{s} {pts} {s},{s}' fill='{color}' opacity='{0.6 + i * 0.15:.2f}'/>")
    elif kind == "waves":
        for i in range(14):
            y = 80 + i * 26
            d = " ".join(f"L{x},{y + 18 * math.sin(x / 45 + i * 0.6):.1f}" for x in range(0, s + 10, 10))
            out.append(f"<path d='M0,{y} {d[1:]}' fill='none' stroke='{primary if i % 3 else secondary}' stroke-width='3' opacity='{0.4 + (i % 4) * 0.15:.2f}'/>")
    elif kind == "blocks":
        for _ in range(16):
            w, h = rng.randint(40, 180), rng.randint(40, 180)
            x, y = rng.randint(0, s - w), rng.randint(0, 400 - h)
            out.append(f"<rect x='{x}' y='{y}' width='{w}' height='{h}' fill='{rng.choice([primary, primary, secondary])}' opacity='0.92'/>")
    elif kind == "stripes":
        for i in range(9):
            out.append(f"<rect x='{-200 + i * 70}' y='-50' width='34' height='800' fill='{primary if i % 2 else secondary}' transform='rotate(-25 {c} {c})'/>")
    return "".join(out)


def cover(product):
    bg, primary, secondary, ink, kind = STYLES[product["id"]]
    rng = random.Random(product["id"])
    return (
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {SIZE} {SIZE}' width='{SIZE}' height='{SIZE}'>"
        f"<rect width='{SIZE}' height='{SIZE}' fill='{bg}'/>"
        f"{pattern(kind, primary, secondary, rng)}"
        f"<rect x='0' y='440' width='{SIZE}' height='160' fill='{bg}' opacity='0.82'/>"
        f"<text x='40' y='510' font-family='Georgia, serif' font-size='44' font-weight='700' fill='{ink}'>{escape(product['name'])}</text>"
        f"<text x='40' y='556' font-family='Helvetica, Arial, sans-serif' font-size='22' letter-spacing='4' fill='{ink}' opacity='0.85'>{escape(product['artist'].upper())}</text>"
        "</svg>\n"
    )


if __name__ == "__main__":
    out = HERE / "covers"
    out.mkdir(exist_ok=True)
    for product in CATALOG:
        (out / f"{product['id']}.svg").write_text(cover(product))
    print(f"{len(CATALOG)} covers written to {out}")
