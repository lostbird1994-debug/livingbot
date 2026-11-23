# Independent desktop application

The 2.0 desktop application hosts the shared workbench web UI and launches the
official OpenClaw kernel using a bundled standalone Node runtime. It has its own
application identity and user-data directory. It neither starts the previous
desktop stack nor reads its credentials.

On first use, the desktop connects to its own service automatically and opens
model settings when no model is configured. The user supplies an endpoint,
protocol, model name and optional API key. Keys stay in the private native
configuration and are never included in model-settings read responses.
Changing models requires current work to finish.

The bundled native plugin includes the six [work methods](work-methods.md).
They appear in the same ability center as other installed methods and can be
enabled per Bot. They provide task guidance through OpenClaw's native skill
loading; specialist formats still require suitable configured tools.

While the application is in the background, newly committed successful or failed
results can produce native system notifications. Clicking one focuses the
application and opens the exact delivered reply. Read state changes only after
that reply renders. The focused application uses its in-app result inbox, and
reopening does not replay old system alerts. If system notifications are
unavailable or disabled, results remain in that inbox.

The import screen accepts a portable `livingbot-migration-v1` manifest. Desktop
users can choose its JSON file through a native file picker, inspect each Bot's
identity, memory, ability files and original exclusions, then select which Bots
to import. Preview creates no active Bot. Each explicit import creates a fresh
verified backup and an independent managed workspace. Database persona,
description and identity color travel with the package; original profile
metadata remains in its workspace. Completed imports can open a conversation.
Prepared packages can also carry shared methods with their supporting files and
shared memory copied only to its original audience. They do not implicitly
authorize external accounts or install a skill's system dependencies.
Reopening the screen retains import history and the current browser session's
batch selection. A batch interrupted by leaving the screen can be continued
from its remaining entries; it is not a durable background batch job.

## Packaging

Build the shared frontend, then provide the official Electron archive, its
official checksum file and a fully initialized OpenClaw installation:

```sh
pnpm --filter @livingbot/workbench-web build
pnpm --filter @livingbot/workbench-desktop package \
  /path/to/electron-v45.0.0-darwin-arm64.zip \
  /path/to/SHASUMS256.txt \
  /path/to/initialized/node_modules
```

The current packager targets macOS arm64, verifies the archive checksum and
kernel version, and creates a fresh ignored release directory on every run.
It includes the web UI, backend, native plugin, initialized kernel dependencies
and standalone Node binary. No application source is linked back to the checkout.
The output is an application bundle and a ZIP; previous builds are retained.

The bundle uses ad-hoc signing for local development. Signing with a distribution
identity, notarization and other operating-system packages remain release work;
building a candidate does not establish their completion.

## Verification

The application's `--smoke-root /absolute/fresh-fixture` mode boots the packaged
backend and official kernel and loads the shared UI in a hidden Electron window.
It checks the authenticated snapshot, static web entry and model settings,
then waits for the renderer to connect and, when unconfigured, display the model
form. It also checks that the preload exposes connection and migration-picker
methods. A credential-free receipt records these results and confirms that the
window remained invisible before shutdown. Repeating against that same fixture
verifies reopening its persisted data.
When the fixture contains a completed result, it also checks the actual
main/preload/renderer notification route by rendering that exact reply. Smoke mode never
shows a system alert; operating-system popup presentation needs separate review.
This check does not exercise native picker dialogs or complete model setup
through Electron controls.
Startup failures are recorded in the private data directory's
`logs/desktop-main.log` or `logs/desktop-backend.log`.

The native model-settings integration starts from an unconfigured application,
saves a synthetic endpoint through the authenticated API, completes a native
turn and reopens the application to check retained configuration and task state:

```sh
node apps/workbench/src/model-settings.integration.ts \
  --kernel-entry /path/to/initialized/node_modules/openclaw/openclaw.mjs
```

Browser acceptance covers the shared settings form and resulting conversation.
Run normal desktop renderer acceptance deliberately; do not use a focus-stealing
Electron suite as routine local verification.
