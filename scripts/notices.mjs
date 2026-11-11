import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = ['Third-party notices for the bundled V0.1 runtime.\nThis file includes licenses for production dependencies; development tools are not shipped.\n'];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev) continue;
  const name = path.split('node_modules/').at(-1);
  const entries = await readdir(path);
  const license = entries.find(entry => /^licen[sc]e(?:[.-].*)?$/i.test(entry));
  if (!license) throw new Error(`Missing runtime license for ${name}; review before packaging.`);
  notices.push(`\n${'='.repeat(72)}\n${name} ${metadata.version} (${metadata.license ?? 'see license'})\n\n${await readFile(join(path, license), 'utf8')}`);
}
await writeFile('THIRD_PARTY_NOTICES.txt', notices.join('\n'));
