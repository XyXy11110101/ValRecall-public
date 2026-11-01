import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Which edition this build is. `edition.json` holds the answer: true in the public repository,
 * false in the author's personal tree. `VALRECALL_PUBLIC_RELEASE=1` forces the public edition.
 */
export function isPublicRelease(): boolean {
  if (process.env.VALRECALL_PUBLIC_RELEASE === '1') return true;
  const edition: unknown = JSON.parse(readFileSync(resolve(__dirname, 'edition.json'), 'utf8'));
  return (
    typeof edition === 'object' &&
    edition !== null &&
    'publicRelease' in edition &&
    edition.publicRelease === true
  );
}
