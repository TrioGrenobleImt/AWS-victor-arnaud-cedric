// `npm test`: starts DynamoDB Local (Docker) once, runs every test file, stops it.
import { spawnSync } from "node:child_process";
import { startDynamoDbLocal, stopDynamoDbLocal, useLocalAws } from "../dev/local-db.js";

useLocalAws();
const started = await startDynamoDbLocal();
const { status } = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), "test/*.test.js"], { stdio: "inherit" });
if (started) stopDynamoDbLocal();
process.exit(status ?? 1);
