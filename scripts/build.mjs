// Builds extension/content/twitch-main.js: the page hook with the worker hook (libs + worker-hook.js)
// embedded as a source string. MAIN-world scripts can't load extension files, hence the inlining.
import { readFile, writeFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
// Libs are ES modules for Node tests; strip module syntax so they concatenate into a plain script.
const unmodule = (src) => src.replace(/^import .*$/gm, '').replace(/^export (const|function|class|let|async function)/gm, '$1');

// Wrapped in an IIFE so nothing (in particular the key) leaks into the worker's global scope, where
// the player code concatenated after it could read it.
const workerSrc = [
  '(() => {',
  unmodule(await read('src/lib/m3u8.js')),
  unmodule(await read('src/lib/token.js')),
  unmodule(await read('src/worker-hook.js')),
  '})();',
].join('\n');

const page = (await read('src/page-hook.js')).replace('WORKER_HOOK_SRC', () => JSON.stringify(workerSrc));
if (page.includes('WORKER_HOOK_SRC')) throw new Error('WORKER_HOOK_SRC placeholder appears more than once');
if (/^\s*(import|export)\b/m.test(workerSrc)) throw new Error('module syntax left in worker source');

await writeFile(new URL('../extension/content/twitch-main.js', import.meta.url), `// BUILT by scripts/build.mjs from src/. Do not edit.\n${page}`);
console.log(`built extension/content/twitch-main.js (worker hook ${workerSrc.length} bytes)`);
