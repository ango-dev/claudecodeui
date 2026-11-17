import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import SidebarRecentConversations from '@/modules/sidebar/SidebarRecentConversations';
import type { SessionWithProvider } from '@/shared/types';

/**
 * The Projects list shows forks under the session they branched from, in the
 * same flat rows as the rest of the list. These tests cover the tree's shape,
 * folding, and that the row actions (open, archive, rename, bulk selection and
 * the view-only Running tab) still reach nested rows.
 */

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));

// The row's "⋯" menu, recorded so a test can call what it was handed.
const recordedOptionsProps: Record<string, unknown>[] = [];
vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (optionsProps: Record<string, unknown>) => {
    recordedOptionsProps.push(optionsProps);
    return null;
  },
}));

// A touch screen gets the bulk toolbar (with Select all); a pointer gets a menu.
const touch = vi.hoisted(() => ({ value: false }));
vi.mock('@/modules/sidebar/hooks/useTouchScreen', () => ({ useTouchScreen: () => touch.value }));

beforeEach(() => {
  recordedOptionsProps.length = 0;
  touch.value = false;
});

const t = ((key: string, options?: { session?: string }) => options?.session ? `${key} ${options.session}` : key) as TFunction;
const noop = () => {};
const root: SessionWithProvider = { id: 'root', summary: 'Original', __provider: 'claude' };
const child: SessionWithProvider = { id: 'child', summary: 'Alternative', __provider: 'claude', forkedFromSessionId: 'root' };
const leaf: SessionWithProvider = { id: 'leaf', summary: 'Experiment', __provider: 'claude', forkedFromSessionId: 'child' };
const unrelated: SessionWithProvider = { id: 'unrelated', summary: 'Other', __provider: 'codex' };
const sessions = [leaf, unrelated, child, root];

const props = (overrides: Partial<ComponentProps<typeof SidebarProjectSessions>> = {}): ComponentProps<typeof SidebarProjectSessions> => ({
  project: { projectId: 'project', displayName: 'Project', fullPath: '/workspace/project' },
  isExpanded: true, sessions, selectedSession: null, initialSessionsLoaded: true,
  hasMoreSessions: false, isLoadingMoreSessions: false,
  activeSessions: new Set(), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
  currentTime: new Date('2026-10-18T00:00:00Z'), sessionRenameId: null, sessionRenameDraft: '',
  onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
  onSaveEditingSession: noop, onSessionSelect: noop, onArchiveSession: noop, onDeleteSession: noop,
  onForkSession: noop, onLoadMoreSessions: noop, onNewSession: noop, selectedSessionIds: null,
  onSetSessionSelection: noop, onToggleSessionSelected: noop, onCancelSessionSelection: noop,
  onDeleteSelectedSessions: noop, t, ...overrides,
});
const rowIds = (container: HTMLElement) => Array.from(container.querySelectorAll('[data-session-id]')).map((row) => row.getAttribute('data-session-id'));
const rowLink = (container: HTMLElement, id: string) => container.querySelector(`[data-session-id="${id}"] a`)!;

test('Projects nests forks, folds them, and still opens a nested row', () => {
  const select = vi.fn();
  const { container } = render(<SidebarProjectSessions {...props({ onSessionSelect: select })} />);
  assert.deepEqual(rowIds(container), ['root', 'child', 'leaf', 'unrelated']);
  assert.equal(container.querySelector('[data-session-id="leaf"]')?.getAttribute('data-fork-depth'), '2');
  assert.equal(container.querySelector('[data-session-id="child"]')?.getAttribute('data-parent-session-id'), 'root');
  assert.equal(container.querySelector('[data-session-id="root"]')?.getAttribute('data-fork-branch'), 'true');
  assert.equal(container.querySelector('[data-session-id="child"]')?.getAttribute('data-fork-branch'), 'true');
  assert.equal(container.querySelector('[data-session-id="leaf"]')?.getAttribute('data-fork-branch'), null);

  fireEvent.click(screen.getByText('Experiment'));
  assert.deepEqual(select.mock.calls, [[leaf, 'project']]);
  select.mockClear();
  const collapse = screen.getByRole('button', { name: 'sessions.collapseForks Original' });
  fireEvent.click(collapse);
  assert.deepEqual(rowIds(container), ['root', 'unrelated']);
  assert.equal(select.mock.calls.length, 0, 'folding does not open the parent');
  assert.equal(collapse.getAttribute('aria-expanded'), 'false');
  fireEvent.click(screen.getByRole('button', { name: 'sessions.expandForks Original' }));
  assert.deepEqual(rowIds(container), ['root', 'child', 'leaf', 'unrelated']);
});

test('indent guides run one per ancestor, and a list without forks keeps its plain rows', () => {
  const second = { ...child, id: 'second', summary: 'Second fork', forkedFromSessionId: 'root' };
  const { container, rerender } = render(<SidebarProjectSessions {...props({ sessions: [leaf, second, child, root, unrelated] })} />);
  const guides = (id: string) => Array.from(container.querySelectorAll(`[data-session-id="${id}"] [data-fork-guide]`))
    .map((guide) => guide.getAttribute('data-fork-guide'));
  assert.deepEqual(rowIds(container), ['root', 'child', 'leaf', 'second', 'unrelated']);
  assert.deepEqual(guides('root'), []);
  assert.deepEqual(guides('child'), ['0']);
  assert.deepEqual(guides('leaf'), ['0', '1']);
  assert.deepEqual(guides('second'), ['0']);
  assert.deepEqual(guides('unrelated'), []);
  // Every row in a forked project leaves room for the chevron, so titles line up.
  assert.ok(rowLink(container, 'unrelated').className.includes('pl-6'));

  rerender(<SidebarProjectSessions {...props({ sessions: [unrelated, root] })} />);
  assert.equal(container.querySelector('[data-fork-guide]'), null);
  assert.equal(container.querySelector('[aria-expanded]'), null);
  assert.ok(!rowLink(container, 'root').className.includes('pl-6'), 'no forks: the row keeps its usual inset');
});

test('a nested row archives itself through its own menu', () => {
  const onArchiveSession = vi.fn();
  const onSessionSelect = vi.fn();
  render(<SidebarProjectSessions {...props({ sessions: [{ ...leaf, forkAncestors: [child, root] }], onArchiveSession, onSessionSelect })} />);
  const leafOptions = recordedOptionsProps.filter((optionsProps) => optionsProps.sessionId === 'leaf').at(-1)!;
  act(() => (leafOptions.onArchiveSession as (sessionId: string) => void)('leaf'));
  assert.deepEqual(onArchiveSession.mock.calls, [['leaf']]);
  assert.equal(onSessionSelect.mock.calls.length, 0);
});

test('double-clicking a nested title renames it, and the chevron steps aside for the editor', () => {
  const onStartEditingSession = vi.fn();
  const { rerender } = render(<SidebarProjectSessions {...props({ onStartEditingSession })} />);
  fireEvent.doubleClick(screen.getByText('Alternative'));
  assert.deepEqual(onStartEditingSession.mock.calls, [['project', 'child', 'Alternative']]);

  rerender(<SidebarProjectSessions {...props({ sessionRenameId: 'child', sessionRenameDraft: 'Alt' })} />);
  assert.equal(screen.queryByRole('button', { name: 'sessions.collapseForks Alternative' }), null);
  assert.ok(screen.getByRole('button', { name: 'sessions.collapseForks Original' }));
});

test('selecting or renaming a hidden descendant opens its complete ancestry', () => {
  const initial = props();
  const { container, rerender } = render(<SidebarProjectSessions {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Alternative' }));
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Original' }));
  rerender(<SidebarProjectSessions {...initial} selectedSession={leaf} />);
  assert.deepEqual(rowIds(container), ['root', 'child', 'leaf', 'unrelated']);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Original' }));
  rerender(<SidebarProjectSessions {...initial} selectedSession={leaf} sessionRenameId="leaf" />);
  assert.ok(container.querySelector('[data-session-id="leaf"]'));
});

test('an off-page source is shown once, and a newly selected fork opens its collapsed source', () => {
  const initial = props({ sessions: [child, root] });
  const { container, rerender } = render(<SidebarProjectSessions {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Original' }));
  const fork = { ...leaf, forkAncestors: [child, root] };
  rerender(<SidebarProjectSessions {...initial} sessions={[fork]} selectedSession={fork} hasMoreSessions />);
  assert.deepEqual(rowIds(container), ['root', 'child', 'leaf']);
  assert.ok(screen.getByRole('button', { name: 'Load more sessions' }));
});

test('live activity and title updates preserve a user collapse around the selected fork', () => {
  const initial = props({ selectedSession: leaf });
  const { container, rerender } = render(<SidebarProjectSessions {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Original' }));
  rerender(<SidebarProjectSessions {...initial} sessions={sessions.map((session) => session.id === 'leaf'
    ? { ...session, summary: 'Updated experiment', lastActivity: new Date().toISOString() }
    : session)} />);
  assert.deepEqual(rowIds(container), ['root', 'unrelated']);
});

test('Select all includes displayed ancestor context and folded forks, excluding responding sessions', () => {
  touch.value = true;
  const onSetSessionSelection = vi.fn();
  render(<SidebarProjectSessions {...props({
    sessions: [{ ...leaf, forkAncestors: [child, root] }], selectedSessionIds: new Set(),
    activeSessions: new Set(['child']), onSetSessionSelection, hasMoreSessions: true,
  })} />);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.selectAllLoaded' }));
  assert.deepEqual([...onSetSessionSelection.mock.calls[0][0].sessionIds], ['root', 'leaf']);
});

test('Ctrl-click ticks a nested row, and a Shift-click range follows the tree on screen', () => {
  const onSetSessionSelection = vi.fn();
  const { container, rerender } = render(<SidebarProjectSessions {...props({ onSetSessionSelection })} />);
  fireEvent.click(rowLink(container, 'leaf'), { ctrlKey: true });
  assert.deepEqual([...onSetSessionSelection.mock.calls[0][0].sessionIds], ['leaf']);

  // Tree order, not the newest-first page order: root, child, leaf, unrelated.
  rerender(<SidebarProjectSessions {...props({ onSetSessionSelection, selectedSessionIds: new Set(['leaf']) })} />);
  fireEvent.click(rowLink(container, 'root'), { shiftKey: true });
  assert.deepEqual([...onSetSessionSelection.mock.calls[1][0].sessionIds].sort(), ['child', 'leaf', 'root']);
});

test('a Shift-click range skips the forks folded out of sight', () => {
  const onSetSessionSelection = vi.fn();
  const { container, rerender } = render(<SidebarProjectSessions {...props({ onSetSessionSelection, selectedSession: unrelated })} />);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Original' }));
  rerender(<SidebarProjectSessions {...props({ onSetSessionSelection, selectedSession: unrelated, selectedSessionIds: new Set() })} />);
  fireEvent.click(rowLink(container, 'root'), { shiftKey: true });
  assert.deepEqual([...onSetSessionSelection.mock.calls.at(-1)![0].sessionIds].sort(), ['root', 'unrelated']);
});

test('a finger drag ticks nested rows in tree order and passes over folded forks', () => {
  const onSetSessionSelection = vi.fn();
  const { container } = render(<SidebarProjectSessions {...props({ onSetSessionSelection, selectedSessionIds: new Set() })} />);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Alternative' }));
  // jsdom has no layout: the nth row on screen covers y from n*32 to n*32+31.
  document.elementFromPoint = (_x: number, y: number) => container.querySelectorAll('[data-select-id]')[Math.floor(y / 32)] ?? null;
  const touch = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ identifier: 1, clientX: x, clientY: y }] });
    act(() => {
      document.dispatchEvent(event);
    });
  };
  // On screen: root, child (folded), unrelated.
  touch('touchstart', 50, 16);
  touch('touchmove', 70, 16);
  touch('touchmove', 70, 2 * 32 + 16);
  touch('touchend', 70, 2 * 32 + 16);
  assert.deepEqual([...onSetSessionSelection.mock.calls.at(-1)![0].sessionIds], ['root', 'child', 'unrelated']);
});

test('the view-only Running tab still folds forks but never selects', () => {
  const onSetSessionSelection = vi.fn();
  const onSessionSelect = vi.fn();
  const { container } = render(<SidebarProjectSessions {...props({ readOnly: true, onSetSessionSelection, onSessionSelect })} />);
  fireEvent.click(rowLink(container, 'leaf'), { ctrlKey: true });
  assert.equal(onSetSessionSelection.mock.calls.length, 0);
  assert.deepEqual(onSessionSelect.mock.calls, [[leaf, 'project']]);
  fireEvent.click(screen.getByRole('button', { name: 'sessions.collapseForks Original' }));
  assert.deepEqual(rowIds(container), ['root', 'unrelated']);
});

test('Conversations stays flat and newest first even when sessions have fork metadata', () => {
  const conversations = [child, unrelated, root].map((session) => ({
    ...session, sessionId: session.id, provider: session.__provider, projectId: 'project',
    projectDisplayName: 'Project', sessionTitle: session.summary!, lastActivity: null,
  }));
  const { container } = render(<SidebarRecentConversations
    conversations={conversations} total={3} hasMore={false} isLoading={false} isLoadingMore={false} hasError={false}
    selectedSession={null} currentTime={new Date()} t={t}
    sessionActions={{
      activeSessions: new Set(), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
      activeRename: null, onRenameDraftChange: noop, onStartEditingSession: noop,
      onCancelEditingSession: noop, onSaveEditingSession: noop, onArchiveSession: noop, onDeleteSession: noop,
    }}
    bulkSelection={{
      sessionSelection: null, onSetSessionSelection: noop, onToggleSessionSelected: noop,
      onCancelSessionSelection: noop, onDeleteSelectedSessions: noop,
    }}
    onConversationSelect={noop} onLoadMore={noop} onRetry={noop}
  />);
  assert.deepEqual(Array.from(container.querySelectorAll('[data-testid="recent-conversation-row"]')).map((row) => row.getAttribute('href')),
    ['/session/child', '/session/unrelated', '/session/root']);
  assert.equal(container.querySelector('[data-testid="project-session-tree"]'), null);
  assert.equal(container.querySelector('[aria-expanded]'), null);
});
