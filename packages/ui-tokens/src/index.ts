export const APPEARANCE_PREFERENCES = [
  "system",
  "light",
  "dark",
  "porcelain",
  "indigo",
  "malachite",
  "dai",
] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark" | "porcelain" | "indigo" | "malachite" | "dai";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  /** Modals: a step lighter than the page so they read as raised above it. */
  dialog: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  /** Fill and hairline where native Liquid Glass is unavailable (Android, iOS before 26). */
  glassFill: string;
  glassStroke: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  /** White in both themes: the user bubble is a solid fill (light grey in dark, near-black in light). */
  chatUserForeground: string;
  /** Distinct backing for scheduled routine replies. */
  chatRoutine: string;
  muted: string;
  mutedForeground: string;
  /** Tertiary text: placeholders, list markers, quote bars, timestamps. */
  faintForeground: string;
  accent: string;
  accentForeground: string;
  /** Destructive text and outlines. */
  destructive: string;
  /** Solid destructive fill (Hang up, a filled Delete); its text is `destructiveForeground`. */
  destructiveFill: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  /** Backing behind a link's site icon. White in both themes so dark logos stay visible on any bubble. */
  faviconPlate: string;
  success: string;
  warning: string;
  statusWorking: string;
  /** Unread dot. The one blue in the inbox, in both themes. */
  unread: string;
  /** Working dot on a busy bot's avatar. The one green, in both themes. */
  workingDot: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
};

export const darkTokens = {
  background: "#141414",
  dialog: "#1E1E1E",
  foreground: "#FFFFFF",
  card: "#202020",
  cardForeground: "#FFFFFF",
  popover: "#202020",
  popoverForeground: "#FFFFFF",
  glassFill: "#2C2C2E",
  glassStroke: "#FCFCFC26",
  primary: "#FFFFFF",
  primaryForeground: "#000000",
  secondary: "#7676803D",
  secondaryForeground: "#FFFFFF",
  chatUser: "#5C5C5C",
  chatUserForeground: "#FFFFFF",
  chatRoutine: "#393322",
  muted: "#202020",
  mutedForeground: "#EBEBF599",
  faintForeground: "#EBEBF573",
  accent: "#78788052",
  accentForeground: "#FFFFFF",
  destructive: "#FF9592",
  destructiveFill: "#E5484D",
  destructiveForeground: "#FFFFFF",
  border: "#FCFCFC14",
  input: "#54545899",
  ring: "#3B82F6",
  sidebar: "#1E1E1E",
  sidebarForeground: "#FFFFFF",
  sidebarBorder: "#FCFCFC14",
  sidebarAccent: "#2B2B2E",
  sidebarAccentForeground: "#FFFFFF",
  link: "#459FFE",
  faviconPlate: "#FFFFFF",
  success: "#3FA266",
  warning: "#DB941E",
  statusWorking: "#459FFE",
  unread: "#006CEB",
  workingDot: "#3FA266",
  overlay: "rgba(0, 0, 0, 0.28)",
  scrollbar: "#1E2026",
  scrollbarHover: "#2E313A",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#FCFCFC",
  dialog: "#FFFFFF",
  foreground: "#000000",
  card: "#EFEFEF",
  cardForeground: "#000000",
  popover: "#FFFFFF",
  popoverForeground: "#000000",
  glassFill: "#FFFFFF",
  glassStroke: "#14141416",
  primary: "#000000",
  primaryForeground: "#FFFFFF",
  secondary: "#7676801F",
  secondaryForeground: "#000000",
  chatUser: "#0B0B0B",
  chatUserForeground: "#FFFFFF",
  chatRoutine: "#FFF0CC",
  muted: "#F2F2F1",
  mutedForeground: "#3C3C43B3",
  faintForeground: "#3C3C4394",
  accent: "#78788029",
  accentForeground: "#000000",
  destructive: "#CE2C31",
  destructiveFill: "#E5484D",
  destructiveForeground: "#FFFFFF",
  border: "#14141414",
  input: "#3C3C434A",
  ring: "#6C6C70",
  sidebar: "#F7F7F7",
  sidebarForeground: "#000000",
  sidebarBorder: "#14141414",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: "#000000",
  link: "#0C64C1",
  faviconPlate: "#FFFFFF",
  success: "#007041",
  warning: "#885A07",
  statusWorking: "#0C64C1",
  unread: "#006CEB",
  workingDot: "#3FA266",
  overlay: "rgba(0, 0, 0, 0.19)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
} as const satisfies ColorTokens;

/**
 * Surfaces that only some themes tint apart from `muted`: a theme can give each kind of
 * bubble its own colour, and a theme that does not is silent here — the component falls back
 * to `--muted`, so nothing changes for it.
 */
export const BUBBLE_TOKENS = ["bubbleBot", "bubbleCard", "bubbleQuote", "bubbleLead"] as const;
export type BubbleToken = (typeof BUBBLE_TOKENS)[number];
export type WebThemeColorTokens = WebColorTokens & Partial<Record<BubbleToken, string>>;

/** Web and Electron only: the primary fill's hover and disabled states. Mobile has no hover. */
export type WebColorTokens = ColorTokens & {
  primaryHover: string;
  primaryDisabled: string;
};

/**
 * Web and Electron values for the tokens they draw differently from the palettes above, which
 * follow the iOS system design for mobile. Mobile reads `darkTokens` / `lightTokens`; web reads
 * `tokens.css`, rendered from these merged palettes. Surfaces are opaque; text, borders, hover
 * and selection are the ink at an opacity, so they read the same on every surface.
 */
export const webDarkOverrides = {
  background: "#161616",
  dialog: "#1F1F1F",
  foreground: "#F5F5F5",
  card: "#1F1F1F",
  cardForeground: "#F5F5F5",
  popover: "#1F1F1F",
  popoverForeground: "#F5F5F5",
  primary: "#F5F5F5",
  primaryHover: "#DBDBDB",
  primaryDisabled: "#F5F5F521",
  primaryForeground: "#121212",
  secondary: "#F5F5F50A",
  secondaryForeground: "#F5F5F5",
  chatUser: "#3E3E3E",
  chatUserForeground: "#F5F5F5",
  muted: "#1F1F1F",
  mutedForeground: "#F5F5F5A8",
  faintForeground: "#F5F5F58A",
  accent: "#F5F5F50F",
  accentForeground: "#F5F5F5",
  destructive: "#FF6463",
  destructiveFill: "#CF2B35",
  border: "#F5F5F51A",
  input: "#F5F5F538",
  ring: "#1884FC",
  sidebar: "#0E0E0E",
  sidebarForeground: "#F5F5F5",
  sidebarBorder: "#F5F5F51A",
  sidebarAccent: "#F5F5F514",
  sidebarAccentForeground: "#F5F5F5",
  link: "#4D9BFF",
  success: "#00BA69",
  warning: "#E28600",
  statusWorking: "#4D9BFF",
  unread: "#4D9BFF",
  workingDot: "#0E9F5A",
  overlay: "#000000B2",
  scrollbar: "#F5F5F538",
  scrollbarHover: "#F5F5F580",
} as const satisfies Partial<WebColorTokens>;

export const webLightOverrides = {
  background: "#FFFFFF",
  foreground: "#1C1C1C",
  card: "#F2F2F2",
  cardForeground: "#1C1C1C",
  popoverForeground: "#1C1C1C",
  primary: "#1C1C1C",
  primaryHover: "#363636",
  primaryDisabled: "#1C1C1C26",
  primaryForeground: "#FCFCFC",
  secondary: "#1C1C1C0F",
  secondaryForeground: "#1C1C1C",
  chatUser: "#1C1C1C",
  muted: "#F2F2F2",
  mutedForeground: "#1C1C1CAD",
  faintForeground: "#1C1C1C8F",
  accent: "#1C1C1C0F",
  accentForeground: "#1C1C1C",
  destructive: "#CD2834",
  destructiveFill: "#E72E3B",
  border: "#1C1C1C1F",
  input: "#1C1C1C3D",
  ring: "#1E86FC",
  sidebar: "#F5F5F5",
  sidebarForeground: "#1C1C1C",
  sidebarBorder: "#1C1C1C1F",
  sidebarAccent: "#1C1C1C14",
  sidebarAccentForeground: "#1C1C1C",
  link: "#0B6DD3",
  success: "#00854A",
  warning: "#AA6300",
  statusWorking: "#0B6DD3",
  unread: "#0B6DD3",
  workingDot: "#10AB61",
  overlay: "#00000080",
  scrollbar: "#1C1C1C3D",
  scrollbarHover: "#1C1C1C85",
} as const satisfies Partial<WebColorTokens>;

export const webDarkTokens: WebColorTokens = { ...darkTokens, ...webDarkOverrides };
export const webLightTokens: WebColorTokens = { ...lightTokens, ...webLightOverrides };

/**
 * Porcelain: the light theme's paper, with colour moved onto the parts that carry it.
 *
 * Page, cards, sidebar and all text stay exactly as the light theme. The fills come from the
 * nine-swatch reference, where every group pairs a deep colour with a pale one. Deep colours go
 * wherever text must read (button, link, focus ring, unread); pale ones only ever paint a
 * surface — measured on white they are 1.26-1.58:1, so they can never carry text themselves.
 * Each kind of bubble gets its own pale colour, which is why this theme defines the bubble
 * slots that other themes leave out.
 */
export const webPorcelainTokens: WebThemeColorTokens = {
  ...webLightTokens,
  primary: "#28517F",
  primaryHover: "#1F4167",
  primaryDisabled: "#28517F33",
  primaryForeground: "#FFFFFF",
  chatUser: "#C7E1FA",
  chatUserForeground: "#1C1C1C",
  link: "#28517F",
  ring: "#28517F",
  unread: "#28517F",
  statusWorking: "#28517F",
  sidebarAccent: "#28517F1A",
  bubbleBot: "#F4F6F3",
  bubbleCard: "#E9E8B9",
  bubbleQuote: "#E4C6D0",
  bubbleLead: "#C7E1FA",
};

/**
 * Sand: a warm paper theme built from a five-colour reference
 * (#2B82AC sky, #DFCBBC sand, #EBB01D wheat, #CD6143 terracotta, #21232A ink).
 *
 * The reference colours only work as fills — measured against the sand page, the
 * sky blue is 3.82:1, terracotta 3.47:1 and wheat 1.74:1 — so every slot that
 * carries text uses a darkened sibling: sky #1F6D93 (5.10:1), terracotta
 * #B04B2F (4.80:1), wheat #8A5F0B (5.02:1). The palette has no green, so
 * success is a derived olive at 4.5:1.
 */

export const webIndigoTokens: WebColorTokens = {
  chatRoutine: darkTokens.chatRoutine,
  background: "#0C5670",
  dialog: "#2C6476",
  foreground: "#F2ECE6",
  card: "#205F74",
  cardForeground: "#F2ECE6",
  popover: "#2C6476",
  popoverForeground: "#F2ECE6",
  glassFill: "#2C6476",
  glassStroke: "#F2ECE616",
  primary: "#EDB79C",
  primaryHover: "#CC9D86",
  primaryDisabled: "#EDB79C55",
  primaryForeground: "#05212B",
  secondary: "#F2ECE60F",
  secondaryForeground: "#F2ECE6",
  chatUser: "#336778",
  chatUserForeground: "#F2ECE6",
  muted: "#205F74",
  mutedForeground: "#F2ECE6E7",
  faintForeground: "#F2ECE6BB",
  accent: "#F2ECE60F",
  accentForeground: "#F2ECE6",
  destructive: "#EEB2AE",
  destructiveFill: "#E3827B",
  destructiveForeground: "#FFFFFF",
  border: "#F2ECE61F",
  input: "#F2ECE63D",
  ring: "#EDB79C",
  sidebar: "#175B72",
  sidebarForeground: "#F2ECE6",
  sidebarBorder: "#F2ECE61F",
  sidebarAccent: "#EDB79C2E",
  sidebarAccentForeground: "#F2ECE6",
  link: "#EDB79C",
  faviconPlate: "#FFFFFF",
  success: "#99CBBB",
  warning: "#E3BB75",
  statusWorking: "#EDB79C",
  unread: "#EDB79C",
  workingDot: "#5BAC91",
  overlay: "#000000B3",
  scrollbar: "#F2ECE63D",
  scrollbarHover: "#F2ECE685",
};

export const webMalachiteTokens: WebColorTokens = {
  chatRoutine: darkTokens.chatRoutine,
  background: "#1B6A67",
  dialog: "#3A7978",
  foreground: "#FFFFFF",
  card: "#2F7372",
  cardForeground: "#FFFFFF",
  popover: "#3A7978",
  popoverForeground: "#FFFFFF",
  glassFill: "#3A7978",
  glassStroke: "#FFFFFF16",
  primary: "#F9D2E4",
  primaryHover: "#D6B5C4",
  primaryDisabled: "#F9D2E455",
  primaryForeground: "#0A2827",
  secondary: "#FFFFFF0F",
  secondaryForeground: "#FFFFFF",
  chatUser: "#427C7D",
  chatUserForeground: "#FFFFFF",
  muted: "#2F7372",
  mutedForeground: "#FFFFFFEE",
  faintForeground: "#FFFFFFC4",
  accent: "#FFFFFF0F",
  accentForeground: "#FFFFFF",
  destructive: "#F5D1CE",
  destructiveFill: "#EA9F9A",
  destructiveForeground: "#FFFFFF",
  border: "#FFFFFF1F",
  input: "#FFFFFF3D",
  ring: "#F9D2E4",
  sidebar: "#266F6D",
  sidebarForeground: "#FFFFFF",
  sidebarBorder: "#FFFFFF1F",
  sidebarAccent: "#F9D2E42E",
  sidebarAccentForeground: "#FFFFFF",
  link: "#F9D2E4",
  faviconPlate: "#FFFFFF",
  success: "#C1E0D6",
  warning: "#EFD7AE",
  statusWorking: "#F9D2E4",
  unread: "#F9D2E4",
  workingDot: "#82BFAB",
  overlay: "#000000B3",
  scrollbar: "#FFFFFF3D",
  scrollbarHover: "#FFFFFF85",
};

export const webDaiTokens: WebColorTokens = {
  chatRoutine: darkTokens.chatRoutine,
  background: "#425066",
  dialog: "#596175",
  foreground: "#F2ECE6",
  card: "#515B70",
  cardForeground: "#F2ECE6",
  popover: "#596175",
  popoverForeground: "#F2ECE6",
  glassFill: "#596175",
  glassStroke: "#F2ECE616",
  primary: "#E4C6D0",
  primaryHover: "#C4AAB3",
  primaryDisabled: "#E4C6D055",
  primaryForeground: "#191E27",
  secondary: "#F2ECE60F",
  secondaryForeground: "#F2ECE6",
  chatUser: "#5E6579",
  chatUserForeground: "#F2ECE6",
  muted: "#515B70",
  mutedForeground: "#F2ECE6E6",
  faintForeground: "#F2ECE6B8",
  accent: "#F2ECE60F",
  accentForeground: "#F2ECE6",
  destructive: "#EEB2AE",
  destructiveFill: "#E3827B",
  destructiveForeground: "#FFFFFF",
  border: "#F2ECE61F",
  input: "#F2ECE63D",
  ring: "#E4C6D0",
  sidebar: "#4A566B",
  sidebarForeground: "#F2ECE6",
  sidebarBorder: "#F2ECE61F",
  sidebarAccent: "#E4C6D02E",
  sidebarAccentForeground: "#F2ECE6",
  link: "#E4C6D0",
  faviconPlate: "#FFFFFF",
  success: "#99CBBB",
  warning: "#E3BB75",
  statusWorking: "#E4C6D0",
  unread: "#E4C6D0",
  workingDot: "#5BAC91",
  overlay: "#000000B3",
  scrollbar: "#F2ECE63D",
  scrollbarHover: "#F2ECE685",
};

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const fontWeight = { regular: "400", medium: "500", semibold: "600" } as const;

/**
 * Native text styles on the system font, in points: iOS body text is 17/22. Titles use the
 * font's own line spacing, written out so they don't inherit a smaller body line height.
 */
export const typeScale = {
  title: { fontSize: 22, lineHeight: 26, fontWeight: fontWeight.semibold },
  headline: { fontSize: 19, lineHeight: 23, fontWeight: fontWeight.semibold },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: fontWeight.medium },
  body: { fontSize: 17, lineHeight: 22 },
  secondary: { fontSize: 15, lineHeight: 19 },
  caption: { fontSize: 14, lineHeight: 18 },
  footnote: { fontSize: 12, lineHeight: 16 },
} as const;

/**
 * Text grows with the iOS text size until body text reaches 23pt, the xxxLarge size. Larger
 * accessibility sizes keep that size, so message bubbles, rows and cards keep their layout.
 */
export const MAX_FONT_SCALE = 23 / typeScale.body.fontSize;

/** The ink of a drawn bot's eyes, the same on every body colour and in both themes. */
export const botEyeColor = "#101014";

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  // Read the list, never a copy of it: a theme added to APPEARANCE_PREFERENCES used to be
  // rejected here, so it applied once and was forgotten on the next load.
  return typeof value === "string" && (APPEARANCE_PREFERENCES as readonly string[]).includes(value);
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  // Mobile has no palette of its own beyond light and dark; it follows which one the theme reads as.
  return appearanceColorScheme(appearance) === "dark" ? darkTokens : lightTokens;
}

/** The web and Electron palette; `tokensForAppearance` is the mobile one. */
/** Themes that paint dark surfaces. Every other theme reads as a light theme. */
export const DARK_APPEARANCES: readonly ResolvedAppearance[] = [
  "dark",
  "indigo",
  "malachite",
  "dai",
];

/** Native widgets and scrollbars only accept light or dark. */
export function appearanceColorScheme(appearance: ResolvedAppearance): "light" | "dark" {
  return DARK_APPEARANCES.includes(appearance) ? "dark" : "light";
}

export const webTokensByAppearance: Record<ResolvedAppearance, WebThemeColorTokens> = {
  light: webLightTokens,
  dark: webDarkTokens,
  porcelain: webPorcelainTokens,
  indigo: webIndigoTokens,
  malachite: webMalachiteTokens,
  dai: webDaiTokens,
};

export function webTokensForAppearance(appearance: ResolvedAppearance): WebThemeColorTokens {
  return webTokensByAppearance[appearance] ?? webLightTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof WebThemeColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(
  selector: string,
  colorScheme: ResolvedAppearance,
  palette: WebThemeColorTokens,
) {
  const lines = (Object.keys(palette) as (keyof WebThemeColorTokens)[])
    .filter((token) => palette[token] !== undefined)
    .map((token) => `  ${cssVariableName(token)}: ${palette[token]?.toLowerCase()};`);
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** The CSS in `tokens.css` (web and Electron). Generated from the web palettes so both stay in sync. */
export function renderTokensCss(): string {
  const blocks = (Object.keys(webTokensByAppearance) as ResolvedAppearance[])
    .filter((appearance) => appearance !== "dark")
    .map((appearance) =>
      renderBlock(
        `[data-theme="${appearance}"]`,
        appearanceColorScheme(appearance),
        webTokensByAppearance[appearance],
      ),
    );
  return `${[
    "/* Generated by `pnpm --filter @livingbot/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", webDarkTokens),
    ...blocks,
  ].join("\n\n")}\n`;
}
