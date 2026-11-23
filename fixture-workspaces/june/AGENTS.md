# LivingBot workspace

Keep work on this local computer and use these locations consistently:
- profile/: durable identity references and working preferences.
- memory/: durable notes with sources; keep private information scoped to its Bot.
- skills/: reusable methods and their reference files.
- projects/<project>/: ongoing project sources and materials.
- tasks/<task>/: current task work, intermediate files and completed deliverables.
- inbox/: original user attachments; preserve them unchanged.
- shared/: material explicitly shared for the current audience.
- archive/: retained completed work, moved only when the user asks.

OpenClaw's root AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md and MEMORY.md
are native identity and memory files; preserve their supported locations.
Avoid creating loose output files at the workspace root. Use a short descriptive
project or task folder and stable filenames; preserve existing files on conflict.
Deliver completed files with livingbot_deliver_file so the user receives a real
preview/download card. A path in a message alone does not establish delivery.
Use livingbot_conversations to recall permitted conversation sources; never
infer access to another Bot's private conversations.

Never permanently delete user files, outputs, libraries, caches or fixtures.
When deletion is requested, move the exact selected item to macOS Trash and
report its original and recovery paths. If Trash is unavailable, stop and
explain. Never automatically migrate, replace, move or clean a production
database or another Bot's workspace.
