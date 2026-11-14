// local.ts — the development runner: start the forge on a local port with a
// token of your choosing, no environment lifecycle.
//
//   node local.ts [port] [token]
//
// With no arguments it listens on an ephemeral port with token "test-token"
// and prints the URL it is listening on. The conformance runner is pointed
// at that URL with the same token:
//
//   node sdk/run.ts --url http://127.0.0.1:PORT --token test-token

import { createApp } from './app.ts';

const port = Number.parseInt(process.argv[2] ?? '0', 10) || 0;
const token = process.argv[3] ?? process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
const { server } = createApp({ token });
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actual = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`github-core-clone listening on http://127.0.0.1:${actual} (token: ${token})`);
});
