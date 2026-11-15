# Inline explanations

The model chooses how to explain a question. Each eligible run receives a short
presentation policy and tool schemas. Detailed design guidance is loaded on demand
through `widget_guidelines`; the full guide is not inserted into every turn.
A teaching explanation can alternate prose, several focused diagrams, a comparison
and a decision aid. Simple answers remain prose. User format instructions win.

## Shared delivery

`widget_guidelines` has five composable modules: diagram, mockup, interactive,
chart and art. They cover the core design system, theme colors, SVG setup, diagram
routing, UI components, local interaction, Chart.js, D3 geography and illustration.
Guidance is original and versioned, independently of the persisted wire version.

`show_widget` accepts a title, SVG or HTML fragment and optional loading messages.
The backend validates the bounded input and inserts the visual into the reply
immediately. Its short tool result confirms delivery; the model does not have to
repeat the source in its final answer. Native cumulative previews retain visual
insertion points, so final text neither duplicates preceding prose nor displaces
its diagrams. Tool settings, approvals and channel restrictions use the same
shared contracts as other built-ins.

Web and Electron render the same document layout: Bot avatar/name above a body
that fills the available transcript width. Content colors are unrestricted;
application chrome continues to use semantic tokens. The host supplies readable
light/dark variables, typography, diagram classes and reduced-motion defaults.
HTML controls, local calculations, steppers, canvas and SVG can update in place.
Theme changes rebuild the widget, resetting its local state.

The controls allow expansion, source inspection/copying, source-file download,
PNG export and adding the visual to the composer. `sendPrompt` requests a reviewed
follow-up after a user gesture. It never sends a message automatically. Table
rendering remains independent of the widget tool: sorting, pagination, expansion,
copy, CSV, visible-page PNG and conversation references work on Markdown tables.

## Execution boundary

Generated code runs in a nested iframe with an opaque origin and no same-origin
permission. A trusted outer relay checks the sending frame and channel. The web
relay has its own served path and restrictive sandbox response header; the main
application's script policy is unchanged. The native WebView hosts the same relay
and exposes no direct native capability to generated code. Frame navigation,
storage, cookies, device access and application API access are unavailable.

The inner policy permits scripts/styles and data only from four established CDNs
(cdnjs, jsDelivr, unpkg and esm.sh), for optional libraries such as Chart.js or D3.
No external service is necessary for self-contained visuals. Library-based widgets
must retain useful fallback content if resources fail. Local file paths and arbitrary
remote image URLs are not supported; images can be embedded as data URLs.

The backend and client both validate the envelope. Raw fragments are bounded at
64,000 characters; encoded parsing is bounded at 96,000. Document wrappers, meta
navigation, nested browsing contexts and forms are rejected. These checks improve
repair feedback; isolation is enforced by the browser, not by a text blacklist.
Rendering errors preserve inspectable source. Validation does not judge factual
claims; factual or explanation-quality evaluation requires the project's opt-in,
provider-neutral LLM rubric workflow.

## Streaming and compatibility

The renderer accepts canonical `livingbot-visual` fences and `show_widget`,
`widget`, or `livingbot-widget` JSON fences. An unfinished JSON string may be
previewed but scripts remain disabled until completion. Runtime tool calls insert
the complete validated component as soon as execution starts. An engine that does
not expose incremental tool arguments cannot preview those arguments while the
model writes them; this is distinct from streaming assistant-text fences.

The native host shares contracts, themes, isolation, local controls, source/image
sharing, expansion and reviewed composer references. It waits for message
completion before enabling generated scripts. Native device acceptance remains a
separate requirement from browser and renderer unit tests.

Older structured diagrams, comparisons and steps still render. Their
`show_visual`/`visual_guidelines` tools are offered as a compatibility fallback when
the full widget tools are disabled, avoiding two competing default presentation
protocols. Old clients display the fenced source as text; no new database block
or migration is required. Messaging and voice omit app-only tools and use prose.

## Verification

Offline unit tests cover contracts, runtime registration, channel/tool selection,
direct insertion, native cumulative text ordering and renderer fallbacks. Browser
fixtures exercise interaction, theme changes, frame/storage isolation, reviewed
follow-ups, progressive inert previews, PNG/source downloads, expansion, phone
width and Markdown table operations. These verify observable behavior, not whether
every stochastic model response will choose the same visual or wording.
