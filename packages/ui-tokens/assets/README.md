# App icon source

`LivingBot.icon` is the shared editable source for macOS and iOS. Open it in Apple's
Icon Composer with Xcode 26 or newer. The 2.0 source is the approved square
purple-eye artwork in `LivingBot.icon/Assets/app-icon.png`. It is centered,
opaque and unshifted, without added glass effects or shadows.

macOS packaging compiles the source into a Tahoe asset catalog and generates the
legacy ICNS fallback. Expo copies the same source into the iOS project.

The platform exports are:

- `apps/desktop/assets/icon-macos.png`: 1024-pixel development export with
  transparent Dock margins.
- `apps/mobile/assets/icon.png`: opaque 1024-pixel square for the generic/legacy icon,
  with no rounded mask or Dock margins.
- `apps/mobile/assets/adaptive-icon.png`: opaque 1024-pixel Android foreground;
  the launcher masks the original square artwork.
- `apps/mobile/assets/icon-background.png`: opaque Android background using the
  shared dark background token.
- Android monochrome launcher artwork is not configured for this photographic
  icon. The previous silhouette is retained as a source for notification exports.

Refresh platform exports after changing the source. Android supplies its own mask;
never bake Mac corners, a rim, or an outer shadow into adaptive layers.

Run `pnpm --filter @livingbot/ui-tokens export:brand` to refresh web, workbench and marketing
favicons, install icons, marketing mark, Windows/Linux icons, mobile splash, and
mobile icons. These use the same approved artwork, a rounded mask for small
browser marks, and transparent splash padding.
The notification export uses the Android monochrome silhouette so its eyes remain
transparent. Apple packaging applies its native mask through Icon Composer;
Android applies the launcher mask to the square export.

After exporting, run `pnpm exec tsx apps/www/scripts/render-og.mjs` to refresh the
marketing page social cards; set `CHROME_PATH` to a headless Chrome executable when
it is not available at the script's default location.

## Animated vector avatars

The existing animated Bot avatar uses SVG paths and gradients in the shared
`logo-avatar-art.ts` definition. Its contour comes from the retained
`LivingBot.icon/Assets/orange-bot.png`, independently of the 2.0 app icon.
The hands and lighting are simplified vector shapes;
the original photographic skin grain is intentionally not reproduced. No raster
body is embedded or loaded by the vector renderer. App icon updates do not
change Bot avatars.
