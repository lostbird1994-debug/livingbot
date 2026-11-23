// Synthetic supervised child. It opens no ports and reads no user data.
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60_000);
