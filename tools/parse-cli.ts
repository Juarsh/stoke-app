// Tester CLI for the offline TS parser (no phone needed).
//   npm run parse -- "2 roti dal"            -> one /v1/parse-shaped JSON response
//   echo '{"text":"2 roti"}' | npm run parse -- --batch   -> one JSON line out per JSON line in
// Batch lines may be {"text": "..."} (backend request shape) or a bare JSON string.
// Responses match the backend's /v1/parse shape with use_ai=false semantics
// (unmatched text is listed in custom_items; no Gemini call).
import * as readline from 'node:readline';
import { parseLocal } from '../src/lib/parseLocal';

const args = process.argv.slice(2);
if (args[0] === '--batch') {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line);
      const text = typeof v === 'string' ? v : v.text;
      if (typeof text !== 'string') throw new Error('need {"text": "..."}');
      process.stdout.write(JSON.stringify(parseLocal(text)) + '\n');
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String((e as Error).message) }) + '\n');
    }
  });
} else if (args.length) {
  process.stdout.write(JSON.stringify(parseLocal(args.join(' ')), null, 2) + '\n');
} else {
  process.stderr.write('usage: npm run parse -- "2 roti dal" | npm run parse -- --batch < meals.jsonl\n');
  process.exit(2);
}
