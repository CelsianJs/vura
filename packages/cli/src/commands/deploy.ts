/**
 * `then deploy` — reserved for the managed Vura deployment platform.
 *
 * The OSS CLI can build deployable artifacts today. Real managed deployments
 * are intentionally handled by the closed-source Vura Platform once enabled.
 */

export async function deployCommand(args: string[]): Promise<void> {
  console.error(`
  vura deploy is not available in the open-source CLI yet.

  What works today:
    vura build      Build production artifacts locally
    vura manifest   Inspect route/deployment classification
    vura dev        Run the local development server

  Managed deployments are handled by Vura Platform and are not part of this
  OSS package release. See https://github.com/zvndev/vura#readme for the
  current self-hosted build and adapter guidance.
`);
  process.exitCode = 1;
}
