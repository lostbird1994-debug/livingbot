import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchWorkbench } from "../../workbench/src/main.ts";
import { watchResultNotifications } from "./result-events.mjs";

let instance;
let closing;
let detachNotifications;
// Disconnect can race both startup and delivery; a failed send is never a process error.
function sendToParent(message) {
  if (process.connected) process.send?.(message, () => {});
}
async function stop() {
  if (closing) return closing;
  closing = (async () => {
    detachNotifications?.();
    if (instance) await instance.close();
    if (process.connected) process.disconnect?.();
  })();
  return closing;
}
process.on("message", (message) => {
  if (message?.type === "stop") void stop().catch(() => { process.exitCode = 1; });
});
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.once("disconnect", () => { void stop(); });

try {
  const [root, kernelEntry, webRoot] = process.argv.slice(2);
  if (!process.send || !root || !kernelEntry || !webRoot) throw new Error("Desktop backend requires its parent");
  instance = await launchWorkbench({
    root, nodeExecutable: process.execPath, kernelEntry, webRoot,
  });
  if (closing || !process.connected) {
    await instance.close();
  } else {
    const { token } = JSON.parse(await readFile(join(root, "client-auth.json"), "utf8"));
    detachNotifications = watchResultNotifications(instance.store, (message) => {
      sendToParent(message);
    });
    sendToParent({ type: "ready", origin: instance.url, token });
  }
} catch (error) {
  console.error(error);
  sendToParent({ type: "failed" });
  await stop().catch(() => {});
  process.exitCode = 1;
}
