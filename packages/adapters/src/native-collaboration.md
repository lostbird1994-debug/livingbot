# Native collaboration bridge

Native model runtimes use the same run-owned executor as built-in models. The
bridge grants only the collaboration tools offered to that run. Sender, user,
space, approvals and delivery deduplication remain in the existing executor.

The authenticated native control connection carries `rakazo.tools.register`,
`poll`, `resolve` and `close`. Native tools wait for the actual executor result.
An approval leaves the original call pending; resuming checks that it still
exists before executing it. Cancelled or expired calls cannot resume delivery.
No tool arguments or prompt text grant authority to select another sender.

OpenClaw requires the bundled `native-collaboration-openclaw.ts` extension and
its adjacent `.plugin.json` manifest. Enable startup activation and permit the
plugin in any applicable tool allowlist. Gateway registration and tool discovery
must share the process-scoped broker. Tools appear only for a registered LivingBot
session; ordinary OpenClaw sessions receive no collaboration tools.

Codex and ACP hosts inject a per-session stdio MCP server using
`native-collaboration-relay.mjs`. The native host owns a loopback endpoint and
queues calls through `NativeCollaborationBroker`; it never delivers messages
itself. Supply the loopback URL, session, run and short-lived client token through
the relay's environment. Pass the MCP server list on session creation and resume.
For Codex, restrict `enabled_tools` to the grant and allow enough tool time for
human approvals. Forward MCP cancellation notifications to the broker.

Keep tokens out of prompts, permanent global MCP settings and logs. Reject
browser origins and redirects at the transport boundary. Revoke the grant when
execution completes or is cancelled; keep it only while a real approval waits.

Tests cover broker isolation, result return, retries, revoke, cancellation, the
stdio MCP wire protocol, plugin registry reuse and native approval continuation.
Native host smoke tests must use a stub executor so no real teammate receives
test messages.
