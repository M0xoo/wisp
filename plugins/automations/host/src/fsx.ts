// A trigger's folder must exist here (v1 fs.existsSync): asked asynchronously, never on the loop.

import { stat } from 'node:fs/promises';

export const isDir = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
};
