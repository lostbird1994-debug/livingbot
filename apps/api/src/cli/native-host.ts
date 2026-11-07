import { readFile } from "node:fs/promises";
import path from "node:path";
import { startHostComputerServer } from "@rakazo/adapters/host-computer-server";
const root = process.env.RAKAZO_NATIVE_ROOT;
if (!root) throw new Error("Native root is required");
const config = JSON.parse(await readFile(path.join(root, "native-host.json"), "utf8"));
const server = await startHostComputerServer({ root: config.root, token: config.token, port: config.port, hostname: "127.0.0.1" });
// This private config is created only by the user's explicit native migration.
if (config.authorized !== true) throw new Error("Native access is not authorized");
server.setEnabled(true);
console.log(JSON.stringify({ nativeHost: "ready", port: server.port, platform: process.platform }));
for (const name of ["SIGTERM", "SIGINT"] as const) process.once(name, async () => { await server.close(); process.exit(0); });
