import os from 'node:os';

import {
  isAntigravityAuthRequiredError,
  withAntigravityAcp,
} from '@/modules/providers/list/antigravity/antigravity-acp.client.js';
import { resolveAntigravityCli } from '@/modules/providers/list/antigravity/antigravity-cli.js';
import {
  readCachedAntigravityTierName,
  syncAntigravityModelCatalogWithSignIn,
} from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';
import { errorMessage, probeCliVersion } from '@/shared/utils.js';

/**
 * Install and sign-in status of the Antigravity CLI.
 *
 * The sign-in is never read from disk: agy keeps it in its own token store,
 * which CloudCLI does not touch. Instead agy is asked over ACP, with a request
 * that changes nothing: `session/list` for the home directory. Verified
 * against agy 1.5.19, it answers a list when signed in and JSON-RPC `-32000
 * "Authentication required"` when not. The answer is cached for 30 seconds,
 * which keeps settings pages and the onboarding poll from starting agy on
 * every render, while a fresh sign-in in the login terminal shows up quickly.
 */

const AUTH_CACHE_TTL_MS = 30_000;

/** Message shown while agy is installed but not signed in, naming the command that signs in. */
const NOT_SIGNED_IN_MESSAGE = 'Not signed in. Run `agy` in a terminal once and sign in with Google.';

type CachedSignIn = {
  home: string;
  command: string;
  expiresAt: number;
  authenticated: boolean;
  error?: string;
};

let cachedSignIn: CachedSignIn | null = null;
let inFlightCheck: Promise<CachedSignIn> | null = null;

async function checkSignIn(command: string): Promise<CachedSignIn> {
  const home = os.homedir();
  const result = (authenticated: boolean, error?: string): CachedSignIn => ({
    home,
    command,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    authenticated,
    ...(error ? { error } : {}),
  });

  try {
    await withAntigravityAcp({ cwd: home }, (connection) =>
      connection.request('session/list', { cwd: home }, { timeoutMs: 20_000 }));
    return result(true);
  } catch (error) {
    if (isAntigravityAuthRequiredError(error)) {
      return result(false, NOT_SIGNED_IN_MESSAGE);
    }
    return result(false, `Could not ask agy for its sign-in: ${errorMessage(error)}`);
  }
}

export class AntigravityProviderAuth implements IProviderAuth {
  /**
   * Runs `agy --version` on the binary chats use (see antigravity-cli.ts).
   * agy 1.5.19 prints a bare `1.5.19`.
   */
  checkInstalled(): CliVersionProbe {
    const cli = resolveAntigravityCli();
    if (!cli) {
      return { installed: false, exitCode: null, version: null };
    }
    return probeCliVersion(cli.command);
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    const cli = resolveAntigravityCli();
    if (!installed || !cli) {
      return {
        installed: false,
        provider: 'antigravity',
        installedVersion: null,
        authenticated: false,
        email: null,
        method: null,
        error: 'Antigravity CLI (agy) is not installed',
      };
    }

    const signIn = await this.readSignIn(cli.command);
    return {
      installed: true,
      provider: 'antigravity',
      installedVersion,
      authenticated: signIn.authenticated,
      // agy names the plan, not the account, over ACP; the account itself
      // stays in agy's token store.
      email: signIn.authenticated ? readCachedAntigravityTierName() ?? 'Google account' : null,
      method: signIn.authenticated ? 'agy_sign_in' : null,
      ...(signIn.authenticated ? {} : { error: signIn.error ?? NOT_SIGNED_IN_MESSAGE }),
    };
  }

  private async readSignIn(command: string): Promise<CachedSignIn> {
    const home = os.homedir();
    if (
      cachedSignIn
      && cachedSignIn.home === home
      && cachedSignIn.command === command
      && cachedSignIn.expiresAt > Date.now()
    ) {
      return cachedSignIn;
    }
    inFlightCheck ??= checkSignIn(command)
      .then((signIn) => {
        syncAntigravityModelCatalogWithSignIn(signIn.authenticated);
        cachedSignIn = signIn;
        return signIn;
      })
      .finally(() => {
        inFlightCheck = null;
      });
    return inFlightCheck;
  }
}
