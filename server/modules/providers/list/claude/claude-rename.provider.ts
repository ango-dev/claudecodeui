import { renameSession as renameClaudeSession } from '@anthropic-ai/claude-agent-sdk';

import type { IProviderRename } from '@/shared/interfaces.js';

/**
 * Retitles a Claude conversation in its transcript.
 *
 * The SDK owns this: it appends the same `custom-title` entry Claude Code's
 * `/rename` writes, which the CLI's `/resume` list and the VS Code panel both
 * read, so a session renamed in CloudCLI shows that name there too.
 */
export class ClaudeRenameProvider implements IProviderRename {
  async renameSession(input: { providerSessionId: string; projectPath: string; title: string }): Promise<void> {
    // `dir` is the session's working directory, which the SDK encodes into the
    // `~/.claude/projects/<encoded>` folder name itself, as for forks.
    await renameClaudeSession(input.providerSessionId, input.title, {
      dir: input.projectPath || undefined,
    });
  }
}
