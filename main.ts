// main.ts — the entry point the trial runs: `node /bot/main.ts`.
//
// The lifecycle the environment expects, in order:
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to
//      register with, so the process exits 1 at once.
//   2. Build the forge (app.ts) and listen on an ephemeral port — the kernel
//      picks a free one. Never bind 8080; the env owns it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records the
//      address the request came from plus N as this entry's base URL and
//      dials it from then on. A 409 means another entry registered first;
//      this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll, not a long-held request. A failed or slow poll is retried with a
//      short exponential backoff; the process never exits before the env
//      says it is done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request may take this long before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// Retries start here and double, up to this ceiling.
const RETRY_FIRST_MS = 250;
const RETRY_CEILING_MS = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
  return Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer
 * and 409 means a first register already won, which is not this process's
 * to fix. 400 and 405 are contract errors and end the program; a network
 * error or any other status is retried, since the env may still be starting.
 */
async function register(port) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitUntilDone() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = await response.json();
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done.
    }
    await sleep(backoff(attempt));
  }
}

async function main() {
  const { server } = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
