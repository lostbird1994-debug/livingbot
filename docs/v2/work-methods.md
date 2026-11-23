# Native work methods

The LivingBot plugin ships six original, provider-neutral methods: documents,
tables/data, research, presentations, project handoff and batch work. OpenClaw
discovers them through the plugin manifest's `skills` directory. They use the
same native skill selection and per-agent permission controls as other methods;
there is no separate execution engine or workspace installation step.

The ability center displays ordinary-language names. Disabling a method affects
the selected Bot's native skill allowlist, not another Bot's access. These
instructions do not grant tools, credentials, account authorization or permission
to publish. User-installed methods retain OpenClaw's source precedence.

The methods preserve originals, scope revisions, retain input references and
sources, record batch progress, distinguish accepted assignments from completed
work, and require real file receipts for delivery. They use configured tools
appropriate to the requested format. Having an eligible method does not prove
that a Word, Excel, image-generation or presentation provider is available.
Unsupported formats must be disclosed rather than simulated by renaming files.

The native integration verifies discovery, independent per-Bot permissions,
restart persistence, reading the packaged document method, actual file edits and
immutable delivery while preserving the original. Its model is synthetic: this
establishes protocol and file effects, not automatic semantic method selection
or complete WorkBuddy parity. The full experience matrix remains authoritative.

```sh
node apps/workbench/src/work-methods.integration.ts \
  --kernel-entry /path/to/initialized/node_modules/openclaw/openclaw.mjs
```
