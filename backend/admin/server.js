import { env } from "../lib/aws.js";
import { createAdminApp } from "./app.js";
import { cognitoVerifier } from "./auth.js";
import { cognitoDirectory } from "./directory.js";

const PORT = Number(process.env.PORT ?? 8080);
const userPoolId = env("USER_POOL_ID");
const verify = cognitoVerifier({ userPoolId, clientId: env("USER_POOL_CLIENT_ID") });
const directory = cognitoDirectory({ userPoolId });

const server = createAdminApp({ verify, directory }).listen(PORT, () => console.log(`admin-api listening on ${PORT}`));

// ECS sends SIGTERM on deployments / scale-in: finish in-flight requests first.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
