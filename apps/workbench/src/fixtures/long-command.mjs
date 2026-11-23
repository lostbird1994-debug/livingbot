import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";

// Explicit integration fixture. Its PID file and output are retained.
if (process.argv[3] === "stubborn") process.on("SIGTERM", () => process.stdout.write("SYNTHETIC-TERM-IGNORED\n"));
await writeFile(process.argv[2], String(process.pid), { mode: 0o600, flag: "wx" });
if (process.argv[3] !== "command") {
  const server = createServer((_request, response) => response.end("synthetic-service"));
  server.listen(0, "127.0.0.1", () => process.stdout.write("SYNTHETIC-SERVICE-READY\n"));
} else process.stdout.write("SYNTHETIC-COMMAND-READY\n");
setInterval(() => process.stdout.write("SYNTHETIC-HEARTBEAT\n"), 1000);
