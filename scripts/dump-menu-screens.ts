/**
 * Dump golden Telegram menu screens (Stage 12A).
 * Run: node --import tsx scripts/dump-menu-screens.ts [--write]
 */
import fs from 'fs';
import path from 'path';
import { buildGoldenScreens, formatGolden, sampleConfig } from '../src/telegram/config-menu';

const out = formatGolden(buildGoldenScreens(sampleConfig()));

if (process.argv.includes('--write')) {
  const dir = path.join(process.cwd(), 'src', 'telegram', '__golden__');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config-menu-screens.txt'), out);
} else {
  process.stdout.write(out);
}
