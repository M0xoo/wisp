// wisp.channels' routes in OpenAPI (the edge merges every plugin's): v1's paths, unchanged.

export const openapi = {
  '/api/remote': {
    get: { summary: 'Channels: config with secrets masked, plus health' },
    put: { summary: 'Change channels; masked tokens mean unchanged' },
  },
  '/api/remote/test': { post: { summary: 'Send a test message to the phone' } },
  '/api/remote/{channel}/{what}': { get: { summary: 'A transport’s extra (Slack’s manifest, Discord’s invite)' } },
  '/api/channels/inbound': { post: { summary: 'A channel message wisp Grid held for this box (from the grid only)' } },
  '/api/channels/routed': { post: { summary: 'A message wisp Grid routed to this computer (through its tunnel only)' } },
  '/api/channels/rotate': { post: { summary: 'Replace this cloud wisp’s inbound URL for a channel' } },
} as const;
