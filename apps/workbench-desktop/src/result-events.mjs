/** Forward committed results only; reopening never replays old system alerts. */
export function watchResultNotifications(store, send) {
  const seen = new Set();
  const receive = (event) => {
    if (event.type !== "notifications.changed") return;
    const notice = event.data;
    if (notice.readAt !== undefined || seen.has(notice.id)) return;
    seen.add(notice.id);
    const bot = store.get("bots", notice.botId);
    send({ type: "result-notification", id: notice.id, name: bot?.name ?? "伙伴", outcome: notice.outcome });
  };
  store.on("event", receive);
  return () => store.off("event", receive);
}
