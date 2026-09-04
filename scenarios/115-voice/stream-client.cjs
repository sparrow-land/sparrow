// stream-client.cjs <ws-url> — drive one hands-free exchange over
// /voice/transcriptions/stream: two binary PCM16 chunks, a commit, then a clean
// close. Prints every server frame as one JSON array on stdout. `ws` is
// resolved from apps/api (a direct dependency there); the scenario runner
// already needs node for the CLI.
const path = require('node:path');
const { createRequire } = require('node:module');
const apiRequire = createRequire(path.join(__dirname, '..', '..', 'apps', 'api', 'package.json'));
const WebSocket = apiRequire('ws');

const url = process.argv[2];
// Optional chunk size in bytes (default 16000 = 500 ms); a short value exercises
// the provider's commit padding against a real vendor.
const chunkBytes = Number(process.argv[3] || 16000);
const frames = [];
const ws = new WebSocket(url);
const done = (code) => {
  process.stdout.write(JSON.stringify(frames) + '\n');
  process.exit(code);
};
const timer = setTimeout(() => { frames.push({ type: 'timeout' }); done(1); }, 10000);
ws.on('open', () => {
  // Two 500 ms chunks of silence at 16 kHz PCM16: enough that a real vendor
  // accepts the commit (ElevenLabs refuses one under 0.3 s), so this client is
  // also a faithful probe against a live instance, not just the fake provider.
  ws.send(Buffer.alloc(chunkBytes));
  ws.send(Buffer.alloc(chunkBytes));
  ws.send(JSON.stringify({ type: 'commit' }));
});
ws.on('message', (data) => {
  let f;
  try { f = JSON.parse(data.toString()); } catch { f = { type: 'unparseable', raw: data.toString() }; }
  frames.push(f);
  if (f.type === 'committed') ws.send(JSON.stringify({ type: 'close' }));
});
ws.on('close', (code) => { frames.push({ type: 'closed', code }); clearTimeout(timer); done(0); });
ws.on('error', (e) => { frames.push({ type: 'socket-error', message: String(e.message || e) }); clearTimeout(timer); done(1); });
