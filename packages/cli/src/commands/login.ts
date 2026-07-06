/**
 * `vura login` — authenticate the CLI against the Vura Platform.
 *
 * Two modes:
 *   vura login                 Interactive email/password prompt (POST /v1/auth/login)
 *   vura login --token <t>     Paste an existing token directly ("paste-token" mode)
 *
 * Either way, credentials land in ~/.vura/credentials at mode 0600 — the same
 * file `vura deploy` and `@celsian/vura-adapter-vura` already read (see
 * `vura-client.ts`), so a successful `vura login` is immediately usable by
 * every other command without extra configuration.
 *
 * Flags:
 *   --token <t>      Store this token directly instead of prompting for email/password.
 *                     The token is verified against GET /v1/auth/me before being saved.
 *   --api-url <url>  API base URL (else VURA_API_URL, else https://api.vura.io)
 */

import * as readline from 'node:readline';
import { formatApiError, resolveApiUrl, vuraApiRequest, writeCredentials } from '../vura-client.js';

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);

interface LoginFlags {
  token?: string;
  apiUrl?: string;
}

interface LoginPrompts {
  /** Prompt for plain text input (echoed as typed). */
  prompt: (question: string) => Promise<string>;
  /** Prompt for a password (not echoed to the terminal). */
  promptPassword: (question: string) => Promise<string>;
}

function parseFlags(args: string[]): LoginFlags {
  const flags: LoginFlags = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--token':
        flags.token = args[++i];
        break;
      case '--api-url':
        flags.apiUrl = args[++i];
        break;
      default:
        // ignore unknown args (keeps house style: lenient flag parsing)
        break;
    }
  }
  return flags;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a password without echoing it to the terminal. Node has no
 * built-in masked-input prompt, so this puts stdin in raw mode and renders
 * `*` per keystroke itself, handling backspace and Ctrl-C/Ctrl-D directly.
 * Requires a real TTY — callers must gate on `process.stdin.isTTY` first.
 */
function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');

    let password = '';
    const onData = (chunk: string) => {
      switch (chunk) {
        case '\n':
        case '\r':
        case CTRL_D:
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
          break;
        case CTRL_C:
          process.stdout.write('\n');
          process.exit(1);
          break;
        case BACKSPACE:
        case '\b':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          password += chunk;
          process.stdout.write('*'.repeat(chunk.length));
          break;
      }
    };
    stdin.on('data', onData);
  });
}

const DEFAULT_PROMPTS: LoginPrompts = { prompt, promptPassword };

/**
 * @param io Override the interactive prompt functions for testing. Defaults
 *           to real stdin/stdout prompts.
 */
export async function loginCommand(args: string[], io: LoginPrompts = DEFAULT_PROMPTS): Promise<void> {
  const flags = parseFlags(args);
  const apiUrl = resolveApiUrl(flags.apiUrl);

  console.log('\n  vura login\n');

  if (flags.token) {
    console.log(`  Verifying token against ${apiUrl}...`);
    let email: string | undefined;
    try {
      const body = (await vuraApiRequest(apiUrl, '/v1/auth/me', { token: flags.token })) as {
        user?: { email?: string };
      };
      email = body?.user?.email;
    } catch (err) {
      console.error(`  ${formatApiError(err)}`);
      process.exitCode = 1;
      return;
    }

    await writeCredentials({ token: flags.token, email });
    console.log(`  Logged in${email ? ` as ${email}` : ''}.`);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error('  Interactive login requires a terminal. Use `vura login --token <token>` in CI or non-interactive environments.');
    process.exitCode = 1;
    return;
  }

  const email = await io.prompt('  Email: ');
  if (!email) {
    console.error('  Email is required.');
    process.exitCode = 1;
    return;
  }

  const password = await io.promptPassword('  Password: ');
  if (!password) {
    console.error('  Password is required.');
    process.exitCode = 1;
    return;
  }

  let result: { token: string; refreshToken?: string; user?: { email?: string } };
  try {
    result = (await vuraApiRequest(apiUrl, '/v1/auth/login', {
      method: 'POST',
      body: { email, password },
    })) as typeof result;
  } catch (err) {
    console.error(`  ${formatApiError(err)}`);
    process.exitCode = 1;
    return;
  }

  await writeCredentials({
    token: result.token,
    email: result.user?.email ?? email,
    refreshToken: result.refreshToken,
  });

  console.log(`  Logged in as ${result.user?.email ?? email}.`);
}
