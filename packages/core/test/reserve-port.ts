import { createServer } from 'node:net';

/**
 * Ask the OS for a port that is free right now, then release it.
 *
 * The tests that boot a real server in a child process cannot use `port: 0`,
 * because the child is the one that binds and it only prints "listening", not
 * the port it got. They therefore have to choose a number up front, and they
 * used to choose it at random from a wide range.
 *
 * That is a birthday problem, not a lottery: the full suite runs many of these
 * files concurrently, so the chance that two of them pick the same number is
 * far higher than the range suggests, and a collision does not fail cleanly.
 * The loser either cannot bind and times out, or, worse, a client connects to
 * the winner's server and asserts against another test's responses. Both shapes
 * have been observed.
 *
 * Binding port 0 and reading back the assignment does not make this airtight:
 * there is still a window between the close here and the child's bind. It does
 * replace "pick a number and hope" with "the OS just told us this one was free",
 * which is as good as this shape of test can get without teaching every child
 * process to report its own port.
 */
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address !== 'object') {
        probe.close(() => reject(new Error('reservePort: server.address() was not an AddressInfo')));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
