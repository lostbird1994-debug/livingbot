# Realtime voice

Voice mode uses the existing chat and run history. Recognition produces normal user
messages; tools and progress remain visual. Native model replies can feed stable
sentences into speech synthesis while they are generated. External runtimes that
only expose a final answer begin speech after that answer becomes available.

Speech providers may implement `VoiceProvider.streamSpeech` with mono PCM16 chunks.
The API exposes an authenticated streaming endpoint; providers without streaming
use complete clips. Web Audio schedules chunks continuously with a bounded playback
lead. Cancelling playback cancels the request and invalidates scheduled audio.
An interrupted call reports an approximate heard prefix with its next user message;
the complete written answer remains in chat.

Calls use a three-second silence fallback. An optional local turn detector can make
the endpoint decision sooner using acoustic evidence. Recognition sentence boundaries
alone do not submit a turn. Barge-in requires at least two Chinese characters or
spoken words and passes the same echo check for interim and final transcripts.

## Optional local turn detection

The API lazily reads `DATA_DIR/voice-turn/config.json`:

```json
{
  "command": [
    "/path/to/python",
    "/path/to/voice-turn-worker.py",
    "/path/to/verified-runtime"
  ]
}
```

The worker directory contains NumPy, ONNX Runtime, the Smart Turn v3.2 CPU model,
Silero VAD model, and Pipecat's `_whisper_features.py`. Supply these from their
official distributions and retain all upstream licenses and attribution.
The API never installs packages or downloads models automatically. The Python worker
is optional, and a missing, invalid or stalled runtime falls back to silence
endpointing. Audio stays in an eight-second memory buffer, isolated per session.
No recordings are saved. A self-hosted recognition bridge may return the same
optional `turn` snapshot fields.

## Notifications and external execution

Notifications use a separate tool-free text-model call, limited to twenty Unicode
characters for the summary, excluding the bot attribution. A missing or failed
summarizer yields a generic new-message notice. Auxiliary summaries never start an
external native agent.

Stopping an OpenClaw run sends a scoped native abort immediately, including paused
approval runs. Exact abort run IDs and native terminal states release the durable
session guard. Missing evidence remains unresolved for reconciliation; already
performed tool side effects are not rolled back. Additional text instructions are
forwarded through OpenClaw's explicit steering command at the next available boundary,
with deterministic request identities and a delivery journal.
