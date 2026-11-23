/** Native presentation only. Results and read receipts remain in the product. */
function resultNotifications({ Notification, getWindow, openResult }) {
  const notices = new Map();
  const seen = new Set();
  return {
    receive(result) {
      const window = getWindow();
      if (seen.has(result.id) || !window || window.isDestroyed()) return;
      seen.add(result.id);
      if (window.isFocused() || !Notification.isSupported()) return;
      const notice = new Notification({
        title: "LivingBot 2",
        body: `${result.name}：${result.outcome === "completed" ? "工作已完成" : "工作未完成"}`,
      });
      notices.set(result.id, notice);
      notice.once("click", () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
        openResult(result.id);
      });
      notice.once("close", () => notices.delete(result.id));
      notice.once("failed", () => notices.delete(result.id));
      notice.show();
    },
    close() {
      for (const notice of notices.values()) notice.close();
      notices.clear();
    },
  };
}
module.exports = { resultNotifications };
