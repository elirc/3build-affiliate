import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A subscriber's endpoint, under our control.
 *
 * The alternative is a mocked transport, which would test that we call a
 * function we wrote. Everything interesting about outbound delivery -- the
 * timeout, what a 500 does, whether an abandoned request is really abandoned
 * -- happens between two sockets, so the tests need two sockets.
 */
export interface RecordedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

export interface StubEndpoint {
  /** A loopback url. Delivery to it needs a transport that permits private targets. */
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/**
 * `respond` is called once per request with the 1-based request number, and
 * returns the status to send. Returning `'hang'` accepts the request and then
 * says nothing at all, which is the failure mode a timeout exists for and the
 * one that is impossible to reproduce without a real server.
 */
export async function startStubEndpoint(
  respond: (requestNumber: number) => number | 'hang'
): Promise<StubEndpoint> {
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const outcome = respond(requests.length);
      if (outcome === 'hang') return;
      res.writeHead(outcome).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // Hung requests are still holding sockets, and `close` alone waits for
        // them -- which is a test suite that hangs at teardown rather than a
        // test that fails.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
