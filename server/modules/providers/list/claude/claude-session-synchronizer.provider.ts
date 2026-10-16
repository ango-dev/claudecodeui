import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildCloudCliSessionName,
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName: string;
  /** False when `sessionName` is one the user typed, which sync keeps. */
  nameIsAutomatic: boolean;
};

type TranscriptTitles = {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  /** Text of the first user message: the source of CloudCLI's placeholder name. */
  firstPrompt?: string;
  /** Every title and prompt value seen, in order. */
  allTitles: string[];
};

const UNTITLED_SESSION_NAME = 'Untitled Claude Session';

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      const rowSessionId = sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      this.recordName(rowSessionId, parsed);
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    const rowSessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
    this.recordName(rowSessionId, parsed);
    return rowSessionId;
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const storedName = existingSession?.custom_name && existingSession.custom_name !== UNTITLED_SESSION_NAME
      ? existingSession.custom_name
      : undefined;
    const titles = await this.readTranscriptTitles(filePath, parsed.sessionId);
    const historyName = nameMap.get(parsed.sessionId);

    // A name the user typed is never replaced.
    if (existingSession && storedName && this.isUsersOwnName(existingSession, storedName, titles, historyName)) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(storedName, UNTITLED_SESSION_NAME),
        nameIsAutomatic: false,
      };
    }

    // An automatic name follows the transcript's own title (a rename from any
    // tool, then Claude's title). CloudCLI's placeholder stays until one exists.
    const sessionName = titles.customTitle || titles.aiTitle || storedName || titles.lastPrompt || historyName;
    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, UNTITLED_SESSION_NAME),
      nameIsAutomatic: true,
    };
  }

  /**
   * Whether a stored name was typed by the user, so sync must keep it.
   *
   * Rows from before `custom_name_auto` carry no answer, so for those a name
   * counts as automatic when CloudCLI could have produced it itself: the
   * placeholder from the first message, or any title or prompt the transcript
   * or history holds. Anything else is a rename the user made.
   */
  private isUsersOwnName(
    session: { custom_name_auto: number | null },
    storedName: string,
    titles: TranscriptTitles,
    historyName: string | undefined,
  ): boolean {
    if (session.custom_name_auto !== null) {
      return session.custom_name_auto === 0;
    }

    const comparable = (value: string) => normalizeSessionName(value, '');
    const target = comparable(storedName);
    const automaticNames = [
      titles.firstPrompt === undefined ? undefined : buildCloudCliSessionName(titles.firstPrompt),
      historyName,
      ...titles.allTitles,
    ];
    return !automaticNames.some((name) => name !== undefined && comparable(name) === target);
  }

  /**
   * Records the name sync settled on, and whether it is automatic, when
   * either differs from the row. `createSession` leaves the names of
   * app-created rows alone, so this is what lets Claude's title replace
   * CloudCLI's placeholder on them.
   */
  private recordName(rowSessionId: string, parsed: ParsedSession): void {
    const row = sessionsDb.getSessionById(rowSessionId);
    if (!row) {
      return;
    }
    const auto = parsed.nameIsAutomatic ? 1 : 0;
    if (row.custom_name !== parsed.sessionName || row.custom_name_auto !== auto) {
      sessionsDb.updateSessionNameState(rowSessionId, parsed.sessionName, parsed.nameIsAutomatic);
    }
  }

  /**
   * Reads the titles one session's transcript holds.
   *
   * Scans forward keeping the last match of each event type: `custom-title`
   * (a rename, from `/rename`, an SDK rename or a fork), `ai-title` (Claude's
   * own) and `last-prompt`. Claude writes `custom-title` immediately before
   * `ai-title`, so callers must prefer the rename rather than the later line.
   * Also keeps the first user prompt and every title value seen, which is how
   * a name from before `custom_name_auto` is recognised as automatic.
   *
   * Returns no titles on a missing or unreadable file so sync can continue.
   */
  private async readTranscriptTitles(filePath: string, sessionId: string): Promise<TranscriptTitles> {
    const titles: TranscriptTitles = { allTitles: [] };
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      return titles;
    }

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (data.sessionId !== sessionId) {
        continue;
      }

      const title = data.type === 'custom-title' ? data.customTitle
        : data.type === 'ai-title' ? data.aiTitle
          : data.type === 'last-prompt' ? data.lastPrompt
            : undefined;
      if (typeof title === 'string' && title.trim()) {
        titles.allTitles.push(title);
        if (data.type === 'custom-title') {
          titles.customTitle = title;
        } else if (data.type === 'ai-title') {
          titles.aiTitle = title;
        } else {
          titles.lastPrompt = title;
        }
        continue;
      }

      if (titles.firstPrompt === undefined && data.type === 'user' && !data.isMeta && !data.isSidechain) {
        titles.firstPrompt = readPromptText(data.message);
      }
    }

    return titles;
  }
}

/** The text of a user message, or undefined for one that carries none (a tool result). */
function readPromptText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlock = content.find((block) => (block as { type?: unknown })?.type === 'text') as { text?: unknown } | undefined;
  return typeof textBlock?.text === 'string' ? textBlock.text : undefined;
}
