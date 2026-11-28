import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  isAntigravityAuthRequiredError,
  withAntigravityAcp,
} from '@/modules/providers/list/antigravity/antigravity-acp.client.js';
import { resolveAntigravityCli } from '@/modules/providers/list/antigravity/antigravity-cli.js';
import { invalidateAntigravityHistory } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import {
  errorMessage,
  normalizeProviderTimestamp,
  normalizeSessionName,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const PROVIDER = 'antigravity';
const FALLBACK_TITLE = 'Untitled Antigravity Session';

/**
 * A full listing is skipped when the last one finished this recently. Every
 * listing returns every session, so a skipped one loses nothing: the next one
 * still upserts whatever changed in between, whatever `since` the caller had.
 */
const FULL_SYNC_MIN_INTERVAL_MS = 15_000;

/** A watcher burst (agy writes its store many times a turn) shares one listing for this long. */
const FILE_SYNC_REUSE_MS = 3_000;

/** Upper bound on `session/list` pages read in one sync. */
const MAX_LIST_PAGES = 50;

type AntigravitySessionInfo = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
};

/**
 * Reads every session agy lists, across `nextCursor` pages, without a `cwd`
 * filter (ACP's `cwd` is optional; agy 1.5.19 then lists all of them).
 * Verified: a session agy never prompted is not listed, so CloudCLI's own
 * model-discovery sessions never show up here.
 */
async function listAllSessions(): Promise<AntigravitySessionInfo[]> {
  const home = os.homedir();
  return withAntigravityAcp({ cwd: home }, async (connection) => {
    const sessions: AntigravitySessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = readObjectRecord(await connection.request('session/list', cursor ? { cursor } : {}, {
        timeoutMs: 30_000,
      })) ?? {};
      for (const entry of Array.isArray(result.sessions) ? result.sessions : []) {
        const record = readObjectRecord(entry) as AnyRecord | null;
        const sessionId = readOptionalString(record?.sessionId);
        const cwd = readOptionalString(record?.cwd);
        if (sessionId && cwd) {
          sessions.push({
            sessionId,
            cwd,
            title: readOptionalString(record?.title) ?? null,
            updatedAt: readOptionalString(record?.updatedAt) ?? null,
          });
        }
      }
      cursor = readOptionalString(result.nextCursor);
      if (!cursor) {
        break;
      }
    }
    return sessions;
  });
}

/**
 * Indexes Antigravity sessions from agy's own `session/list` (ACP), never from
 * its conversation files. The sessions watcher watches agy's conversation
 * folder (`~/.gemini/antigravity-cli/conversations/<id>.db`) only for change
 * events, so a CLI session shows up in the sidebar soon after it changes.
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private lastFullSyncAt = 0;
  private inFlightList: Promise<AntigravitySessionInfo[]> | null = null;
  private lastList: { at: number; sessions: AntigravitySessionInfo[] } | null = null;

  async synchronize(): Promise<number> {
    if (!resolveAntigravityCli() || Date.now() - this.lastFullSyncAt < FULL_SYNC_MIN_INTERVAL_MS) {
      return 0;
    }
    const sessions = await this.list();
    if (!sessions) {
      return 0;
    }
    this.lastFullSyncAt = Date.now();
    let processed = 0;
    for (const session of sessions) {
      if (this.upsertSession(session)) {
        processed += 1;
      }
    }
    return processed;
  }

  /**
   * Handles a watcher event on agy's conversation folder: `<id>.db` (and its
   * `-wal` / `-shm` companions) names the session that changed.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    const match = /^(.+)\.db(?:-wal|-shm)?$/.exec(path.basename(filePath));
    if (!match || !resolveAntigravityCli()) {
      return null;
    }
    const providerSessionId = match[1];
    invalidateAntigravityHistory(providerSessionId);

    const reuse = this.lastList && Date.now() - this.lastList.at < FILE_SYNC_REUSE_MS && this.lastList.sessions;
    const sessions = reuse || await this.list();
    const session = sessions?.find((entry) => entry.sessionId === providerSessionId);
    return session ? this.upsertSession(session) : null;
  }

  /** One listing at a time; null when agy is signed out or failed (logged). */
  private async list(): Promise<AntigravitySessionInfo[] | null> {
    this.inFlightList ??= listAllSessions().finally(() => {
      this.inFlightList = null;
    });
    try {
      const sessions = await this.inFlightList;
      this.lastList = { at: Date.now(), sessions };
      return sessions;
    } catch (error) {
      if (!isAntigravityAuthRequiredError(error)) {
        console.warn('[Antigravity] Could not list sessions:', errorMessage(error));
      }
      return null;
    }
  }

  private upsertSession(session: AntigravitySessionInfo): string | null {
    const { sessionId, cwd } = session;
    // A chat started in CloudCLI has an app row whose provider id the runtime
    // reports mid-turn; bind it first so the listing does not add a second row.
    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.findLatestPendingAppSession(PROVIDER, cwd);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, sessionId);
    }

    const existing = sessionsDb.getSessionByProviderSessionId(sessionId) ?? sessionsDb.getSessionById(sessionId);
    const existingName = existing?.custom_name;
    const name = existingName && existingName !== FALLBACK_TITLE ? existingName : session.title ?? undefined;
    const updatedAt = normalizeProviderTimestamp(session.updatedAt ?? undefined);

    // agy keeps each conversation in its own store; jsonl_path stays null so
    // deleting a session in CloudCLI never deletes agy's files.
    return sessionsDb.createSession(
      sessionId,
      PROVIDER,
      cwd,
      normalizeSessionName(name, FALLBACK_TITLE),
      updatedAt,
      updatedAt,
      null,
    );
  }
}
