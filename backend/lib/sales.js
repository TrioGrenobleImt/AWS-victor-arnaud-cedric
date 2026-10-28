// Monthly sales dashboard, computed from the orders of the by_month index.
import { listOrders, STATUSES } from "./orders.js";
import { listProducts } from "./products.js";

export const LOW_STOCK = 5;
const round2 = (n) => Math.round(n * 100) / 100;

export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export async function monthlySales(month) {
  const [orders, products] = await Promise.all([listOrders(month), listProducts()]);
  const [year, mon] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const daily = Array.from({ length: days }, (_, i) => ({ day: i + 1, revenue: 0, orders: 0 }));
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byProduct = new Map();
  let revenue = 0;
  let itemsSold = 0;

  for (const order of orders) {
    byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
    if (order.status === "CANCELLED") continue; // not a sale
    revenue += order.total;
    const day = daily[Number(order.created_at.slice(8, 10)) - 1];
    day.revenue += order.total;
    day.orders += 1;
    for (const line of order.items) {
      itemsSold += line.quantity;
      const p = byProduct.get(line.product_id) ?? { product_id: line.product_id, name: line.name, quantity: 0, revenue: 0 };
      p.quantity += line.quantity;
      p.revenue += line.quantity * line.unit_price;
      byProduct.set(line.product_id, p);
    }
  }

  const sales = orders.length - byStatus.CANCELLED;
  return {
    month,
    revenue: round2(revenue),
    orders: sales,
    items_sold: itemsSold,
    average_order: sales ? round2(revenue / sales) : 0,
    by_status: byStatus,
    daily: daily.map((d) => ({ ...d, revenue: round2(d.revenue) })),
    top_products: [...byProduct.values()]
      .map((p) => ({ ...p, revenue: round2(p.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5),
    low_stock: products.filter((p) => p.stock <= LOW_STOCK).map((p) => ({ id: p.id, name: p.name, artist: p.artist, stock: p.stock })),
  };
}
