# wisp.telemetry

Anonymous usage stats (v1 `server/telemetry.js`, `services/telemetry.js`), as ADR-0021 has it.

## Intent

- Fixed values only (harness, model, mode, status, timings, counts): never prompts, paths, project names
  or agent output; error text is scrubbed of the home folder and cut to 500 characters.
- Off with `DO_NOT_TRACK=1`, `WISP_TELEMETRY=0`, `CI`, or Settings → Usage stats off; nothing queued is
  sent after you turn it off.
- One random id per install, not tied to the machine or the user.
- Sending never gets in the way: batches go every 15 s or at 50 events, each sink on its own with a 3 s
  budget, and a batch a sink doesn't take is dropped.
- The catalogue (`api/src/catalogue.json`) is v1's 52 events with their property keys; an event or a key
  it doesn't list is never sent. The page may send only its own events and values.
- Sinks deliver it (`telemetry.sink@1`); `wisp.posthog` is one. No other plugin names a vendor.

## Not yet

Feedback (thumbs, /feedback) and its offline outbox, exceptions, the queue kept across a crash, and the
events of plugins not ported yet (they emit with `telemetry.track` as each is).
