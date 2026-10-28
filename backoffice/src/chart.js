// Single-series column chart (daily revenue): thin columns with a rounded data
// end, hairline grid, per-column hover/focus tooltip and a table view.
const W = 720;
const H = 240;
const PAD = { top: 12, right: 8, bottom: 26, left: 44 };

function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
}

const compact = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(Math.round(n)));

/** Column path with a 4px rounded top, square at the baseline. */
function column(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function columnChart(container, data, { label, format }) {
  const max = Math.max(...data.map((d) => d.value), 0);
  const step = niceStep(max || 1);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / data.length;
  const barW = Math.min(24, band * 0.62);
  const y = (v) => PAD.top + plotH - (v / top) * plotH;

  const grid = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid.push(
      `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}"/>`,
      `<text class="tick" x="${PAD.left - 8}" y="${y(v)}" dy="0.32em" text-anchor="end">${compact(v)}</text>`,
    );
  }
  const labelEvery = data.length > 16 ? 5 : 1;
  const bars = data
    .map((d, i) => {
      const cx = PAD.left + band * i + band / 2;
      const h = Math.max(0, PAD.top + plotH - y(d.value));
      const tick = (i + 1) % labelEvery === 0 || i === 0 ? `<text class="tick" x="${cx}" y="${H - 8}" text-anchor="middle">${d.label}</text>` : "";
      return `<g class="col" tabindex="0" data-i="${i}" aria-label="${d.label}: ${format(d.value)}">
        <rect class="hit" x="${cx - band / 2}" y="${PAD.top}" width="${band}" height="${plotH}"/>
        ${h > 0 ? `<path class="bar" d="${column(cx - barW / 2, y(d.value), barW, h)}"/>` : ""}
        ${tick}
      </g>`;
    })
    .join("");

  container.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
        ${grid.join("")}
        <line class="axis" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(0)}" y2="${y(0)}"/>
        ${bars}
      </svg>
      <div class="tooltip" hidden></div>
    </div>
    <details class="table-view">
      <summary>View as table</summary>
      <table><thead><tr><th>Day</th><th class="num">${label}</th><th class="num">Orders</th></tr></thead>
      <tbody>${data.map((d) => `<tr><td>${d.label}</td><td class="num">${format(d.value)}</td><td class="num">${d.orders}</td></tr>`).join("")}</tbody></table>
    </details>`;

  const chart = container.querySelector(".chart");
  const tooltip = container.querySelector(".tooltip");
  const show = (g) => {
    const d = data[Number(g.dataset.i)];
    tooltip.innerHTML = `<strong>${d.title}</strong><span>${format(d.value)} · ${d.orders} order${d.orders === 1 ? "" : "s"}</span>`;
    tooltip.hidden = false;
    const box = g.querySelector(".hit").getBoundingClientRect();
    const host = chart.getBoundingClientRect();
    const left = Math.min(Math.max(box.left - host.left + box.width / 2, 70), host.width - 70);
    tooltip.style.left = `${left}px`;
    chart.querySelectorAll(".col.active").forEach((el) => el.classList.remove("active"));
    g.classList.add("active");
  };
  const hide = () => {
    tooltip.hidden = true;
    chart.querySelectorAll(".col.active").forEach((el) => el.classList.remove("active"));
  };
  chart.querySelectorAll(".col").forEach((g) => {
    g.addEventListener("mouseenter", () => show(g));
    g.addEventListener("focus", () => show(g));
    g.addEventListener("blur", hide);
  });
  chart.addEventListener("mouseleave", hide);
}
