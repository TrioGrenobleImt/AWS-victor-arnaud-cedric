import { env } from "../lib/aws.js";
import { createAdminApp } from "./app.js";
import { cognitoVerifier } from "./auth.js";

const PORT = Number(process.env.PORT ?? 8080);
const verify = cognitoVerifier({ userPoolId: env("USER_POOL_ID"), clientId: env("USER_POOL_CLIENT_ID") });

const server = createAdminApp({ verify }).listen(PORT, () => console.log(`admin-api listening on ${PORT}`));

// ECS sends SIGTERM on deployments / scale-in: finish in-flight requests first.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
