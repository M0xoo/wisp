// Starting points for a new connector (Settings → Connectors, and the issue picker's Connect Linear… /
// Connect Jira…): the form filled in, the secret left for you. signIn: the server signs in with the
// browser (OAuth), so the form offers Add and sign in first. DOM-free: the tests read it too.

export const EXAMPLES = [
  { label: 'Linear', name: 'linear', transport: 'remote', url: 'https://mcp.linear.app/mcp', signIn: true },
  { label: 'Jira', name: 'atlassian', transport: 'remote', url: 'https://mcp.atlassian.com/v1/mcp', signIn: true },
  { label: 'PostHog', name: 'posthog', transport: 'remote', url: 'https://mcp.posthog.com/mcp', signIn: true },
  { label: 'GitHub', name: 'github', transport: 'remote', url: 'https://api.githubcopilot.com/mcp/', headers: [{ key: 'Authorization', placeholder: 'Bearer ghp_…' }] },
  { label: 'Filesystem', name: 'filesystem', transport: 'local', command: 'npx -y @modelcontextprotocol/server-filesystem ~/Documents' },
  { label: 'Postgres', name: 'postgres', transport: 'local', command: 'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb' },
];

// The example an issue source points at ('linear', 'jira'), or null.
export const exampleFor = (source) => EXAMPLES.find((x) => x.label.toLowerCase() === source) || null;

// Whether a connector (saved or not) is for that source: its name, URL or command says so, as the
// server's own check does (server/issues.js).
export const isFor = (source, c) => (source === 'jira' ? /jira|atlassian/i : /linear/i).test([c.name, c.url, c.command, ...(c.args || [])].join(' '));
