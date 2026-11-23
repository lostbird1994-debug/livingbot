export type DesktopBridge = {
  connect(): Promise<{ origin: string; token: string }>;
  chooseMigrationBundle(): Promise<string | undefined>;
  onOpenResult(open: (id: string) => void): () => void;
};

export function desktopBridge(): DesktopBridge | undefined {
  return (window as Window & { livingbotDesktop?: DesktopBridge }).livingbotDesktop;
}
