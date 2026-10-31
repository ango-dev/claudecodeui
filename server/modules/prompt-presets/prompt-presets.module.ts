import { projectsDb, promptPresetsDb } from '@/modules/database/index.js';
import { createPromptPresetsRouter } from '@/modules/prompt-presets/prompt-presets.routes.js';
import { createPromptPresetsService } from '@/modules/prompt-presets/prompt-presets.service.js';

const promptPresetsService = createPromptPresetsService({
  presets: promptPresetsDb,
  projectExists: (projectId) => projectsDb.getProjectById(projectId) !== null,
  now: () => new Date(),
});

/** Prompt presets router over the real database, mounted by the server entrypoint at `/api/prompt-presets`. */
export const promptPresetsRoutes = createPromptPresetsRouter(promptPresetsService);
