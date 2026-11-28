import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { StandaloneShell } from '@/modules/standalone-shell';
import { IS_PLATFORM } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';

/**
 * For empty shell instances where no project is provided,
 * we use a default project object to ensure the shell can still function.
 * This prevents errors related to missing project data.
 *
 * `projectId` is set to a well-known sentinel ('default') because the empty
 * shell doesn't correspond to any real project row in the database; any API
 * call that routes through this placeholder must tolerate a missing match.
 */
const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: IS_PLATFORM ? '/workspace' : '',
  path: IS_PLATFORM ? '/workspace' : '',
};

type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  provider?: LLMProvider;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
  isAuthenticated?: boolean;
};

const getProviderCommand = ({
  provider,
  customCommand,
  isAuthenticated: _isAuthenticated,
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated: boolean;
}) => {
  if (customCommand) {
    return customCommand;
  }

  if (provider === 'claude') {
    return 'claude --dangerously-skip-permissions /login';
  }

  if (provider === 'cursor') {
    return 'cursor-agent login';
  }

  if (provider === 'codex') {
    return IS_PLATFORM ? 'codex login --device-auth' : 'codex login';
  }

  if (provider === 'opencode') {
    return 'opencode auth login';
  }

  // agy has no separate login subcommand: its first interactive run signs in with Google.
  if (provider === 'antigravity') {
    return 'agy';
  }

  return 'claude --dangerously-skip-permissions /login';
};

const getProviderTitle = (provider: LLMProvider) => {
  if (provider === 'claude') return 'Claude CLI Login';
  if (provider === 'cursor') return 'Cursor CLI Login';
  if (provider === 'codex') return 'Codex CLI Login';
  if (provider === 'opencode') return 'OpenCode CLI Login';
  if (provider === 'antigravity') return 'Antigravity CLI Login';
  return 'Claude CLI Login';
};

/**
 * How to install a CLI that does not come with CloudCLI, shown under the
 * modal's title: running the login command is the first time most people
 * find out the CLI is missing. Only Antigravity needs one so far.
 */
const PROVIDER_INSTALL_COMMANDS: Partial<Record<LLMProvider, { unix: string; windows: string }>> = {
  antigravity: {
    unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    windows: 'irm https://antigravity.google/cli/install.ps1 | iex',
  },
};

/** Used by the onboarding and settings modules to run a provider's CLI login command in an embedded shell. */
export default function ProviderLoginModal({
  isOpen,
  onClose,
  provider = 'claude',
  onComplete,
  customCommand,
  isAuthenticated = false,
}: ProviderLoginModalProps) {
  const { t } = useTranslation();
  if (!isOpen) {
    return null;
  }

  const command = getProviderCommand({ provider, customCommand, isAuthenticated });
  const title = getProviderTitle(provider);
  const installCommands = PROVIDER_INSTALL_COMMANDS[provider];

  const handleComplete = (exitCode: number) => {
    onComplete?.(exitCode);
    // Keep the modal open so users can read terminal output before closing.
  };

  return (
    <div
      data-escape-layer
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 max-md:items-stretch max-md:justify-stretch"
    >
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={t('common:misc.closeLoginModal')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {installCommands && (
          <div
            data-testid="provider-login-install-hint"
            className="space-y-1 border-b border-gray-200 px-4 py-2.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300"
          >
            <p>{t('common:providerLogin.installHint', { defaultValue: 'Not installed yet? Install it on the server first:' })}</p>
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-gray-500 dark:text-gray-400">macOS / Linux</span>
              <code className="break-all rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-900 dark:bg-gray-900 dark:text-gray-100">
                {installCommands.unix}
              </code>
            </p>
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-gray-500 dark:text-gray-400">Windows</span>
              <code className="break-all rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-900 dark:bg-gray-900 dark:text-gray-100">
                {installCommands.windows}
              </code>
            </p>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          <StandaloneShell project={DEFAULT_PROJECT_FOR_EMPTY_SHELL} command={command} onComplete={handleComplete} minimal={true} />
        </div>
      </div>
    </div>
  );
}
