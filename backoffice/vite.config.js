import { defineConfig } from "vite";

// Served from the root of its own CloudFront distribution (back-office bucket).
// `npm run dev` talks to the local backend (`npm run dev` in backend/, token "dev");
// set ADMIN_BACKEND to use another one.
const backend = process.env.ADMIN_BACKEND ?? "http://localhost:8080";

export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      "/admin/api": { target: backend, changeOrigin: true },
      "/images": { target: backend, changeOrigin: true },
    },
  },
  plugins: [
    {
      // In production Terraform uploads config.json with the Cognito settings.
      name: "dev-config",
      configureServer(server) {
        server.middlewares.use("/config.json", (req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ auth: "dev" }));
        });
      },
    },
  ],
});
