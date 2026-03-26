/**
 * `then deploy` — Deploy the built project via Celsian or provider adapters.
 *
 * For managed deployments, use Celsian (https://celsian.dev).
 * For self-managed deployments, use provider adapters directly:
 *   - @then/adapter-cloudflare
 *   - @then/adapter-lambda
 */

export async function deployCommand(args: string[]): Promise<void> {
  console.log(`
  then deploy

  Deploy requires a Celsian account. Sign up at https://celsian.dev

  Celsian handles building, deploying, and scaling your ThenJS app
  across edge workers, serverless functions, and hot servers.

  To deploy locally without Celsian, use provider adapters directly:

    # Cloudflare Workers
    npx wrangler deploy

    # AWS Lambda
    npx @then/adapter-lambda deploy

  Learn more: https://thenjs.dev/docs/deploy
`);
}
