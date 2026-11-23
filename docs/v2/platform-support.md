# Platform support

What ships today, what the desktop app and a browser actually share, and what is
deliberately not available. This page states current support and the shape of the
evidence behind it, not a roadmap promise. The acceptance rows are in
`experience-matrix.md` (E45 and the rows named below); the mobile deferral is
recorded in `release-priorities.md`.

## One product, two front ends, one backend

LivingBot 2.0 has one local backend and one web interface. The macOS app is an
Electron shell that starts that backend and shows that interface in a window; a
browser opens the same interface at the backend's loopback address. Workflows are
implemented once, in the backend and the interface — not once per front end.

    packages/workbench/     shared data types and backend workflow code
    apps/workbench/         local backend: authentication, API, event stream, static web
    apps/workbench-web/     the interface both front ends render
    apps/workbench-desktop/ Electron shell: window, preload bridge, notifications

Shared by the two front ends:

- **API and events.** One HTTP API on a loopback port. State arrives as ordered
  events on one server-sent stream with a cursor, so a reload or a reconnect
  resumes instead of replaying what was already read.
- **Authentication.** One bearer token, read from the product's own data
  directory. It travels in the `Authorization` header and never in a URL; without
  it the API answers 401.
- **Data types.** Shared TypeScript types define the common shape of tasks,
  messages, files, batches and abilities. They keep both front ends speaking one
  vocabulary; they do not by themselves prevent an interface from displaying a
  wrong state, which is why each workflow below also has behavioural evidence.
- **Data directory.** The app's own directory.

## What the desktop shell adds

Platform integration only, never product behavior:

| Desktop capability | Browser behavior |
| --- | --- |
| Opens already connected, using the token its preload reads | Shows the local address and access key form; the key is typed or pasted |
| Native file picker for an import bundle | The picker is absent; type or paste the bundle path, everything else works |
| Notification that opens the result window | No OS notification; results stay in the conversation, work records and file center |
| Application icon supplied by the bundle | The window icon is desktop-only; a browser tab has no icon yet (see limits) |

## How the evidence is shaped

Three kinds of evidence exist, and they are not interchangeable:

1. **Browser session against a backend started from the checkout** — the real
   interface, the real API and a real kernel; the desktop shell is not involved.
2. **Native kernel fixture** — a real kernel turn through the backend; no packaged
   app and no window.
3. **Packaged application startup smoke** — the built app boots with its bundled
   Node, official kernel and web assets; the hidden renderer connects, the
   first-use model form and the preload interfaces exist. This proves the bundle
   starts and wires up; it does **not** exercise each workflow inside the package.

| Workflow | Matrix | Evidence today |
| --- | --- | --- |
| Conversation with ordered streaming, work record per task | E04, E19 | browser sessions; native kernel fixtures; packaged startup smoke |
| Stop a turn or a process the app started | E11, E12 | browser sessions; native kernel fixtures |
| Tables: read, copy and export | E21 | browser session (exact clipboard text and exported bytes) |
| File batch: open each item's own result, retry only failures | E25 | browser sessions; native kernel fixture |
| Routines: create, pause, inspect, open the result | E20 | browser session; native kernel fixtures |
| Group discussion and separate private reports | E37, E39 | browser session; native kernel fixtures |
| Import existing Bots | E36 | browser session (bundle path typed); the packaged smoke only reports that the native picker interface exists |
| Memory recall and scoped memory | E34, E35 | browser session; native kernel fixtures |
| Manage abilities in one place | E40 | browser session; native kernel fixtures |
| Install or share through GitHub | E42 | browser session; native kernel fixtures |

No workflow is claimed as verified end to end inside the packaged desktop just
because it works in a browser session and the package boots.

## Not supported: mobile

There is no mobile build of 2.0. Conversations, batches, tables, routines, import,
abilities, marketplace and memory are all unavailable on a phone, and nothing in
the product claims otherwise. Full native mobile is deferred in
`release-priorities.md` until the local desktop is stable; E45 stays Partial until
mobile workflows are actually verified.

The repository still contains the previous product's Expo client under
`apps/mobile`. It is not wired to 2.0: it speaks a different protocol against a
server address of its own, names none of this product's packages, endpoints, data
directory or token file, and nothing in 2.0 imports it. It therefore has no
automatic access to 2.0 work — reaching a 2.0 backend from it would take a
deliberate, unsupported reconfiguration plus the local token, not merely opening
the old app.

## Known limits

- **Loopback only.** Browser sessions are local; remote access, phone access and
  cross-device use are not supported.
- **A browser tab needs the access key by hand.** There is no pairing and no
  account sign-in for this local product.
- **One data directory belongs to one running backend.** A desktop window and a
  browser tab may both attach to the same running backend; starting a second
  backend process against the same directory is not a supported configuration.
- **No tab icon yet (observed, fixable, open).** The static handler's MIME
  allowlist currently serves html, css, js, svg and woff2 only, so a request for
  `favicon.ico` or an app icon returns 404 in a browser tab. The files are present
  in the built web root, so this is a small server-side omission owned by the
  packaging owner. It is not a design decision, not a platform acceptance blocker,
  and not fixed yet.
