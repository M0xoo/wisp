// Every view this plugin registers, by id, so one area opens another's without importing it
// (client.navigate({ t: 'openView' | 'openOverlay', … })). Ids start with the plugin id (the client
// refuses others).

export const VIEW = {
  /** main: Org, who hands work to whom (v1 org.js) */
  org: 'wisp.crew.org',
  /** overlay: a member's (or the whole crew's) track record (v1 crew-record.js); params { id?: string } */
  record: 'wisp.crew.record',
  /** overlay: Share… one or more members (v1 crew-share.js); params { ids: string[] } */
  share: 'wisp.crew.share',
  /** overlay: Import… a crew bundle (v1 crew-share.js); params { text?: string } */
  import: 'wisp.crew.import',
  /** overlay: add or edit a member (v1 crewEditor); params { id?: string, task?: string, template?: string } */
  editor: 'wisp.crew.editor',
} as const;

export type ViewId = (typeof VIEW)[keyof typeof VIEW];
