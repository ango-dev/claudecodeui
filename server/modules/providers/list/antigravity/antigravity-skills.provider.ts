import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

/**
 * Customization roots agy discovers in a project (its 1.5.19 customization
 * guide): `.agents/` and its spellings `.agent/`, `_agents/`, `_agent/`, in
 * every directory from the working directory up to the repository root.
 */
const ANTIGRAVITY_PROJECT_ROOTS = ['.agents', '.agent', '_agents', '_agent'];

/**
 * Antigravity skills: `skills/<name>/SKILL.md` under each project
 * customization root and under the global root `~/.gemini/config/`. agy offers
 * skills as slash commands (its `available_commands_update` lists them next to
 * its built-in commands), so they are `/name`.
 */
export class AntigravitySkillsProvider extends SkillsProvider {
  constructor() {
    super('antigravity');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    let currentPath = path.resolve(workspacePath);
    const stopAt = repoRoot ? path.resolve(repoRoot) : currentPath;
    for (;;) {
      for (const root of ANTIGRAVITY_PROJECT_ROOTS) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(currentPath, root, 'skills'),
          commandPrefix: '/',
        });
      }
      const parentPath = path.dirname(currentPath);
      if (currentPath === stopAt || parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, await this.getGlobalSkillSource());
    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.gemini', 'config', 'skills'),
      commandPrefix: '/',
    };
  }
}
