import { defineConfig } from "vite";

// Served by CloudFront under /admin/ (S3 web bucket, admin/ prefix).
// `npm run dev` talks to the local backend (`npm run dev` in backend/, token "dev");
// set ADMIN_BACKEND to use another one.
const backend = process.env.ADMIN_BACKEND ?? "http://localhost:8080";

export default defineConfig({
  base: "/admin/",
  server: {
    port: 5174,
    proxy: {
      "/admin/api": { target: backend, changeOrigin: true },
      "/images": { target: backend, changeOrigin: true },
    },
  },
  plugins: [
    {
      // In production Terraform uploads admin/config.json with the Cognito settings.
      name: "dev-config",
      configureServer(server) {
        server.middlewares.use("/admin/config.json", (req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ auth: "dev" }));
        });
      },
    },
  ],
});
