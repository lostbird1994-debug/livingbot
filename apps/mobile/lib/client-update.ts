import { configureClientBuild } from "./api";

/** LivingBot installs are distributed explicitly; upstream OTA updates are disabled. */
export function mobileClientBuild(): string | null {
  return null;
}
export function clientBuildHeaders(): Record<string, string> {
  return {};
}
export async function applyRequiredUpdate(): Promise<void> {}
export function noteClientUpdateRequired(): void {}
export function installClientUpdates(): void {
  configureClientBuild({ headers: clientBuildHeaders, onUpdateRequired: noteClientUpdateRequired });
}
export function watchForegroundUpdates(_now?: () => number): () => void {
  return () => {};
}
