# Native interactive replies

LivingBot declares OpenClaw's `inline-widgets` client capability. OpenClaw owns
`show_widget`, JavaScript validation, HTML wrapping, document storage and the
Canvas references included in native chat events and history.

The product stores document references with their originating session. An
authenticated message/block endpoint resolves only a saved reference through
`canvas.document.view`; arbitrary document IDs and native host connection
metadata are not exposed through that endpoint. Startup enables the official
isolated preview host by default with a separate loopback port, while preserving
an explicit disabled setting.

Replies render those documents in an iframe with `sandbox="allow-scripts"`.
The native document's resource policy remains intact. The product handles native
size reports only from that iframe's window and sends shared appearance tokens
when the theme changes. The iframe receives no application credential or host
command handler. Export downloads the original native HTML document.

The native inline prompt channel connects `sendPrompt` and
`openclaw.prompt.send` to the existing product message-submission endpoint.
Only the first offered message port from this iframe is accepted, and prompt
delivery requires browser user activation. The host supplies the Bot and
conversation from the saved reply; widget text cannot choose a different
recipient. Leaving the reply closes its prompt port.

An uncertain send retains its exact submission ID and text in the current
tab's session storage, scoped to the service, message and widget. The visible
retry reuses that same identity, including after reload. The regular backend
and OpenClaw retain ownership of acceptance, queueing and execution.

Local JavaScript interaction and inline SVG are verified through the actual
kernel and browser. A reloaded document starts its local JavaScript state again;
persisting a document does not persist arbitrary JavaScript variables.

Dashboard pinning, persistent widget state/data grants, PNG snapshots and broader
external-library compatibility are not yet verified
product workflows. They remain follow-up integration work; native tool
availability does not establish those host interactions as implemented.

Run the deterministic native transport check against an initialized kernel:

```sh
node apps/workbench/src/widgets.integration.ts --kernel-entry /path/to/openclaw/openclaw.mjs
```

The test uses a synthetic model and isolated application data. It verifies
native tool dispatch, final projection, official document reads, complete
restart retention, authenticated product access and unknown-reference rejection.
It does not grade real-model visual quality or semantic tool selection.
