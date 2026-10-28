import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 8080);

// Task id + AZ from the ECS task metadata endpoint (v4), shown by /api/health
// so the demo can show the load balancing between tasks.
let identity = { instance: "local", az: "local" };
if (process.env.ECS_CONTAINER_METADATA_URI_V4) {
  fetch(`${process.env.ECS_CONTAINER_METADATA_URI_V4}/task`)
    .then((r) => r.json())
    .then((task) => (identity = { instance: task.TaskARN.split("/").pop().slice(0, 12), az: task.AvailabilityZone }))
    .catch((err) => console.error("task metadata unavailable", err));
}

const server = createApp({ instance: () => identity }).listen(PORT, () => console.log(`shop-api listening on ${PORT}`));

// ECS sends SIGTERM on deployments / scale-in: finish in-flight requests first.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
