# wisp.posthog

A `telemetry.sink@1` that delivers wisp.telemetry's batches to PostHog exactly as v1 did: `POST
<WISP_POSTHOG_HOST or https://us.i.posthog.com>/batch/` with `{ api_key, batch }`, v1's write-only project
key unless `WISP_POSTHOG_KEY` says otherwise (empty: nothing goes), 3 s budget, a failure dropped. Turning
it off leaves wisp.telemetry and any other sink as they are (ADR-0021).
