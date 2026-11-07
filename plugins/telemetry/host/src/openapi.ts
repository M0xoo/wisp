// wisp.telemetry's routes in the OpenAPI document (the edge merges every plugin's).
export const openapi = {
  '/api/feedback': { post: { summary: 'Send feedback to the wisp team: thumbs on a turn and/or a note' } },
  '/api/telemetry/event': { post: { summary: 'Count a page event (only the listed ones, with their allowed values)' } },
} as const;
