// The Changes panel's rows: shared by the parsed diff (index.ts) and the hunk helpers (hunks.ts).

/** One row of a file's hunks, as the Changes panel draws it. */
export type DiffRow = { op: ' ' | '+' | '-'; text: string; a?: number; b?: number } | { op: '…'; count: number };

export interface DiffFile {
  path: string;
  from?: string;
  status: 'A' | 'M' | 'D' | 'R';
  add: number;
  del: number;
  binary: boolean;
  rows: DiffRow[];
  /** rows past the cap: counted, not sent */
  more: number;
  generated?: true;
}
