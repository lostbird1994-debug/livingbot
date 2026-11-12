import { afterEach, describe, expect, it, vi } from "vitest";

const updates = vi.hoisted(() => ({
  isEnabled: true,
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
const rn = vi.hoisted(() => ({
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: vi.fn() },
  Linking: { openURL: vi.fn() },
}));
vi.mock("expo-updates", () => updates);
vi.mock("react-native", () => rn);
vi.mock("./api", () => ({ configureClientBuild: vi.fn() }));

import { configureClientBuild } from "./api";
import {
  applyRequiredUpdate,
  clientBuildHeaders,
  installClientUpdates,
  mobileClientBuild,
  noteClientUpdateRequired,
  watchForegroundUpdates,
} from "./client-update";

afterEach(() => vi.clearAllMocks());
describe("LivingBot mobile update isolation", () => {
  it("does not enroll in upstream client update requirements", () => {
    expect(mobileClientBuild()).toBeNull();
    expect(clientBuildHeaders()).toEqual({});
    installClientUpdates();
    expect(configureClientBuild).toHaveBeenCalledWith({
      headers: clientBuildHeaders,
      onUpdateRequired: noteClientUpdateRequired,
    });
  });
  it("neither downloads nor opens an upstream store when an update is requested", async () => {
    noteClientUpdateRequired();
    await applyRequiredUpdate();
    expect(updates.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(updates.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    expect(rn.Alert.alert).not.toHaveBeenCalled();
    expect(rn.Linking.openURL).not.toHaveBeenCalled();
  });
  it("does not register foreground checks even if an old native build enables OTA", () => {
    const stop = watchForegroundUpdates(() => 0);
    expect(rn.AppState.addEventListener).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
