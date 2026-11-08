const label = document.getElementById("label");
const detail = document.getElementById("detail");
const mute = document.getElementById("mute");
window.voiceOverlay.onState((state) => {
  label.textContent = state.label;
  detail.textContent = state.detail;
  mute.textContent = state.muted ? "继续" : "静音";
  mute.setAttribute("aria-pressed", String(state.muted));
});
mute.addEventListener("click", () => window.voiceOverlay.control("mute"));
document
  .getElementById("exit")
  .addEventListener("click", () => window.voiceOverlay.control("exit"));
