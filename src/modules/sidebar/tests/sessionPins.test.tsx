import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem, SessionRowActions, SidebarProjectListProps } from '@/shared/types';
import { SessionPinsProvider } from '@/modules/sidebar/SessionPinsProvider';
import { useSessionPins } from '@/modules/sidebar/hooks/useSessionPins';
import SidebarContent from '@/modules/sidebar/SidebarContent';
import SidebarRecentConversations from '@/modules/sidebar/SidebarRecentConversations';
import { RECENT_SESSIONS_SELECTION_SCOPE } from '@/modules/sidebar/utils/sidebarSelectionScopes';

// Pins are server state (SessionPinsProvider); the fork offers Pin and Unpin in
// each row's "⋯" menu, marks an explicitly pinned row with a pin glyph, puts a
// project's pinned families under a "Pinned" heading at the top of that
// project, and gives the Conversations list a "Pinned" group above the recent one.

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), touch: false,
}));
// A touch screen gets the bulk toolbar (with Select all); a pointer gets a menu.
vi.mock('@/modules/sidebar/hooks/useTouchScreen', () => ({ useTouchScreen: () => mocks.touch }));
vi.mock('@/shared/api', () => ({
  api: {
    pinnedSessions: mocks.load,
    setSessionPinned: mocks.save,
    providerSessionId: async () => ({ ok: true, json: async () => ({ data: { sessionId: 'native' } }) }),
  },
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(['claude', 'codex']),
}));
vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));

const t = ((key: string, fallback?: string | { defaultValue?: string }) =>
  typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key) as TFunction;
const noop = () => {};
const EMPTY_PROJECTS: Project[] = [];
const NOW = new Date('2026-10-23T12:00:00Z');
const conversation = (sessionId: string): RecentConversationListItem => ({
  sessionId, provider: 'codex', projectId: 'project-1', projectDisplayName: 'Project one',
  sessionTitle: `Title ${sessionId}`, lastActivity: '2026-10-23T11:00:00Z',
});
const A = conversation('a'), B = conversation('b');
const PROJECTS: Project[] = [{
  projectId: 'project-1', fullPath: '/workspace/one', displayName: 'Project one',
  sessions: [{ id: 'a', summary: A.sessionTitle, __provider: 'codex' }, { id: 'b', summary: B.sessionTitle, __provider: 'codex' }],
  sessionMeta: { total: 2, hasMore: false },
}];
const actions: SessionRowActions = {
  activeRename: null, activeSessions: new Set(), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
  onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
  onSaveEditingSession: noop, onArchiveSession: noop, onDeleteSession: noop,
};
const listProps: SidebarProjectListProps = {
  ...actions, projects: PROJECTS, filteredProjects: PROJECTS, selectedProject: null, selectedSession: null,
  isLoading: false, loadingProgress: null, isProjectExpanded: () => true,
  initialSessionsLoaded: new Set(['project-1']), currentTime: NOW, deletingProjects: new Set(),
  getProjectSessions: (project) => (project.sessions ?? []).map((session) => ({ ...session, __provider: session.__provider ?? 'codex' })),
  onLoadMoreSessions: noop, loadingMoreProjects: new Set(), isProjectStarred: () => false,
  onToggleProject: noop, onProjectSelect: noop, onToggleStarProject: noop,
  onStartEditingProject: noop, onCancelEditingProject: noop, onSaveProjectName: noop, onDeleteProject: noop,
  onSessionSelect: noop, onNewSession: noop, sessionSelection: null, onSetSessionSelection: noop,
  onToggleSessionSelected: noop, onCancelSessionSelection: noop, onDeleteSelectedSessions: noop, t,
};
const contentProps = (mode: 'projects' | 'conversations'): ComponentProps<typeof SidebarContent> => ({
  isMobile: false, isLoading: false, projects: PROJECTS, runningSessionsCount: 0,
  archivedProjects: [], archivedSessions: [], archivedSessionsCount: 0, isArchivedSessionsLoading: false,
  recentConversations: [A, B], recentConversationsTotal: 2, recentConversationsHasMore: false,
  isRecentConversationsLoading: false, isLoadingMoreRecentConversations: false, recentConversationsError: false,
  searchFilter: '', onSearchFilterChange: noop, onClearSearchFilter: noop, searchMode: mode,
  onSearchModeChange: noop, conversationResults: null, isSearching: false, searchProgress: null,
  onRestoreArchivedProject: noop, onLoadMoreRecentConversations: noop, onRetryRecentConversations: noop,
  onArchivedSessionClick: noop, onRestoreArchivedSession: noop, onRestoreArchivedSessions: noop,
  onDeleteArchivedSession: noop, onConversationResultClick: noop, onRefresh: noop, isRefreshing: false,
  onCreateProject: noop, onCollapseSidebar: noop, updateAvailable: false, restartRequired: false,
  releaseInfo: null, latestVersion: null, onShowVersionModal: noop, onShowSettings: noop,
  projectListProps: listProps, t,
});
const response = (sessions: RecentConversationListItem[]) => ({ ok: true, json: async () => ({ data: { sessions } }) });
const wrapper = ({ children }: { children: ReactNode }) => <SessionPinsProvider projects={EMPTY_PROJECTS}>{children}</SessionPinsProvider>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Opens a row's "⋯" menu. */
async function openOptions(title: string, scope: HTMLElement = document.body) {
  await act(async () => {
    fireEvent.click(within(scope).getByRole('button', { name: `Session options for ${title}` }));
  });
}

/** Picks Pin or Unpin from a row's menu once the pin list is ready (the item waits for it). */
async function choosePinItem(title: string, label: 'Pin' | 'Unpin', scope?: HTMLElement) {
  await openOptions(title, scope);
  const item = await screen.findByRole('menuitem', { name: label });
  await waitFor(() => assert.equal(item.hasAttribute('disabled'), false));
  await act(async () => { fireEvent.click(item); });
}

const treeIds = (tree: HTMLElement) => [...tree.querySelectorAll('[data-session-id]')].map((row) => row.getAttribute('data-session-id'));
/** The rows that carry the pin glyph: explicit pins only, never their relatives. */
const glyphIds = (tree: HTMLElement) => [...tree.querySelectorAll('[data-session-id]')]
  .filter((row) => row.querySelector('[aria-label="Pinned"]'))
  .map((row) => row.getAttribute('data-session-id'));
/** The tree's section headings in screen order. */
const headings = (tree: HTMLElement) => [...tree.children]
  .filter((child) => !child.hasAttribute('data-session-id'))
  .map((child) => child.textContent);

beforeEach(() => {
  mocks.touch = false;
  mocks.load.mockReset().mockResolvedValue(response([A]));
  mocks.save.mockReset().mockResolvedValue(response([]));
});

test('Projects heads a project\'s pins with "Pinned"; Conversations collects pins first in their own group without duplicates', async () => {
  mocks.load.mockResolvedValue(response([B]));
  const { rerender } = render(
    <SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('projects')} /></SessionPinsProvider>,
  );
  const projectTree = screen.getByTestId('project-session-tree');
  await waitFor(() => assert.deepEqual(glyphIds(projectTree), ['b']));
  assert.deepEqual(treeIds(projectTree), ['b', 'a']);
  assert.deepEqual(headings(projectTree), ['Pinned', 'Recent sessions']);
  assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false);
  assert.equal(screen.getAllByText('Title b').length, 1);

  rerender(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('conversations')} /></SessionPinsProvider>);
  const pinned = screen.getByTestId('pinned-sessions-section');
  assert.ok(within(pinned).getByText('Pinned'));
  assert.ok(within(pinned).getByText('Title b'));
  assert.ok(within(pinned).getByText('Project one'));
  assert.equal(screen.getAllByText('Title b').length, 1);
  const recentRows = screen.getAllByTestId('recent-conversation-row');
  assert.deepEqual(recentRows.map((row) => row.textContent?.includes('Title b')), [true, false]);
  assert.ok(screen.getByText('Recent sessions'));
});

test('unpin from the menu uses the server response and returns the session to the recent group', async () => {
  const { rerender } = render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('conversations')} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  await choosePinItem('Title a', 'Unpin', screen.getByTestId('pinned-sessions-section'));
  await waitFor(() => assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false));
  assert.deepEqual(mocks.save.mock.calls.map(([id, pinned]) => [id, pinned]), [['a', false]]);
  assert.ok(within(screen.getByTestId('recent-conversations-list')).getByText('Title a'));
  rerender(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('projects')} /></SessionPinsProvider>);
  const tree = screen.getByTestId('project-session-tree');
  assert.deepEqual(headings(tree), []);
  assert.deepEqual(glyphIds(tree), []);
});

test('project pins remain scoped to their owner and include older pages without altering pagination', async () => {
  const c = { ...conversation('c'), projectId: 'project-2', projectDisplayName: 'Project two' };
  const older = conversation('older');
  const projects: Project[] = [
    { ...PROJECTS[0], sessionMeta: { total: 20, hasMore: true } },
    { projectId: 'project-2', fullPath: '/workspace/two', displayName: 'Project two', sessions: [
      { id: 'd', summary: 'Title d', __provider: 'codex' },
      { id: 'c', summary: c.sessionTitle, __provider: 'codex' },
    ], sessionMeta: { total: 2, hasMore: false } },
  ];
  mocks.load.mockResolvedValue(response([c, older, B]));
  const more = vi.fn();
  const props = contentProps('projects');
  props.projects = projects;
  props.projectListProps = { ...listProps, projects, filteredProjects: projects,
    initialSessionsLoaded: new Set(['project-1', 'project-2']), onLoadMoreSessions: more };
  render(<SessionPinsProvider projects={projects}><SidebarContent {...props} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByText('Title older')));
  const trees = screen.getAllByTestId('project-session-tree');
  assert.deepEqual(treeIds(trees[0]), ['older', 'b', 'a']);
  assert.deepEqual(glyphIds(trees[0]), ['older', 'b']);
  assert.deepEqual(headings(trees[0]), ['Pinned', 'Recent sessions']);
  assert.deepEqual(treeIds(trees[1]), ['c', 'd']);
  assert.deepEqual(glyphIds(trees[1]), ['c']);
  assert.equal(screen.getAllByText('Title c').length, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }));
  assert.deepEqual(more.mock.calls, [['project-1']]);
});

test('pinning any family member lifts the whole fork tree and marks only the explicit pin', async () => {
  const projects: Project[] = [{ ...PROJECTS[0], sessions: [
    { id: 'newest', summary: 'Newest', __provider: 'codex' },
    { id: 'c', summary: 'Title c', __provider: 'codex', forkedFromSessionId: 'b' },
    { id: 'b', summary: 'Title b', __provider: 'codex', forkedFromSessionId: 'a' },
    { id: 'sibling', summary: 'Sibling', __provider: 'codex', forkedFromSessionId: 'a' },
    { id: 'a', summary: 'Title a', __provider: 'codex' },
  ] }];
  let savedPins: RecentConversationListItem[] = [];
  mocks.load.mockResolvedValue(response([]));
  mocks.save.mockImplementation(async (id: string, pinned: boolean) => {
    savedPins = pinned ? [conversation(id), ...savedPins] : savedPins.filter((pin) => pin.sessionId !== id);
    return response(savedPins);
  });
  const props = contentProps('projects');
  props.projectListProps = { ...listProps, projects, filteredProjects: projects };
  render(<SessionPinsProvider projects={projects}><SidebarContent {...props} /></SessionPinsProvider>);
  const tree = screen.getByTestId('project-session-tree');
  const treeUi = within(tree);
  const rows = () => [...tree.querySelectorAll('[data-session-id]')]
    .map((row) => [row.getAttribute('data-session-id'), row.getAttribute('data-parent-session-id'), row.getAttribute('data-fork-depth')]);
  const family = [['a', null, '0'], ['b', 'a', '1'], ['c', 'b', '2'], ['sibling', 'a', '1']];
  const newest = ['newest', null, '0'];
  assert.deepEqual(rows(), [newest, ...family]);

  for (const id of ['a', 'b', 'c']) {
    await choosePinItem(`Title ${id}`, 'Pin', tree);
    await waitFor(() => assert.deepEqual(rows(), [...family, newest]));
    assert.deepEqual(glyphIds(tree), [id]);
    assert.deepEqual(headings(tree), ['Pinned', 'Recent sessions']);
    assert.equal(tree.querySelector('[data-session-id="b"] [data-fork-guide]') !== null, true);
    fireEvent.click(within(tree.querySelector('[data-session-id="a"]') as HTMLElement).getByRole('button', { name: 'sessions.collapseForks' }));
    assert.deepEqual(rows(), [family[0], newest]);
    fireEvent.click(treeUi.getByRole('button', { name: 'sessions.expandForks' }));
    assert.deepEqual(rows(), [...family, newest]);
    await choosePinItem(`Title ${id}`, 'Unpin', tree);
    await waitFor(() => assert.deepEqual(rows(), [newest, ...family]));
    assert.deepEqual(glyphIds(tree), []);
    assert.deepEqual(headings(tree), []);
  }

  // Removing one of several explicit pins keeps the family lifted.
  await choosePinItem('Title a', 'Pin', tree);
  await waitFor(() => assert.deepEqual(glyphIds(tree), ['a']));
  await choosePinItem('Title c', 'Pin', tree);
  await waitFor(() => assert.deepEqual(glyphIds(tree), ['a', 'c']));
  await choosePinItem('Title a', 'Unpin', tree);
  await waitFor(() => assert.deepEqual(glyphIds(tree), ['c']));
  assert.deepEqual(rows(), [...family, newest]);
  await choosePinItem('Title c', 'Unpin', tree);
  await waitFor(() => assert.deepEqual(rows(), [newest, ...family]));
}, 20_000);

test('an off-page pinned ancestor keeps its own parent and paginated descendants', async () => {
  const projects: Project[] = [{ ...PROJECTS[0], sessions: [
    { id: 'newest', summary: 'Newest', __provider: 'codex' },
    { id: 'c', summary: 'Title c', __provider: 'codex', forkedFromSessionId: 'b', forkAncestors: [
      { id: 'b', summary: 'Old title b', __provider: 'codex', forkedFromSessionId: 'a' },
      { id: 'a', summary: 'Title a', __provider: 'codex' },
    ] },
  ], sessionMeta: { total: 30, hasMore: true } }];
  mocks.load.mockResolvedValue(response([B]));
  const props = contentProps('projects');
  const more = vi.fn();
  props.projectListProps = { ...listProps, projects, filteredProjects: projects, onLoadMoreSessions: more };
  render(<SessionPinsProvider projects={projects}><SidebarContent {...props} /></SessionPinsProvider>);
  const tree = screen.getByTestId('project-session-tree');
  await waitFor(() => assert.deepEqual(glyphIds(tree), ['b']));
  assert.deepEqual([...tree.querySelectorAll('[data-session-id]')].map((row) => [
    row.getAttribute('data-session-id'), row.getAttribute('data-parent-session-id'), row.getAttribute('data-fork-depth'),
  ]), [['a', null, '0'], ['b', 'a', '1'], ['c', 'b', '2'], ['newest', null, '0']]);
  assert.equal(screen.getAllByText('Title b').length, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }));
  assert.deepEqual(more.mock.calls, [['project-1']]);
});

test('renaming a pinned project row opens one editor in its project', async () => {
  function RenameHarness() {
    const [activeRename, setActiveRename] = useState<SessionRowActions['activeRename']>(null);
    const props = contentProps('projects');
    props.projectListProps = {
      ...listProps, activeRename,
      onStartEditingSession: (projectId, id, draft) => setActiveRename({ target: 'session', projectId, id, draft }),
    };
    return <SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} /></SessionPinsProvider>;
  }
  render(<RenameHarness />);
  const tree = screen.getByTestId('project-session-tree');
  await waitFor(() => assert.deepEqual(glyphIds(tree), ['a']));
  await openOptions('Title a', tree);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  assert.equal(screen.getAllByRole('textbox').length, 1);
  assert.ok(within(tree).getByRole('textbox'));
});

test('a pin does not select the session it is picked for', async () => {
  const select = vi.fn();
  const props = contentProps('projects');
  props.projectListProps = { ...listProps, onSessionSelect: select };
  mocks.load.mockResolvedValue(response([]));
  mocks.save.mockResolvedValue(response([B]));
  render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} /></SessionPinsProvider>);
  const tree = screen.getByTestId('project-session-tree');
  await choosePinItem('Title b', 'Pin', tree);
  await waitFor(() => assert.deepEqual(glyphIds(tree), ['b']));
  assert.deepEqual(treeIds(tree), ['b', 'a']);
  assert.equal(select.mock.calls.length, 0);
  assert.deepEqual(mocks.save.mock.calls.map(([id, pinned]) => [id, pinned]), [['b', true]]);
});

test('search and archived views do not show the Pinned group', async () => {
  const props = contentProps('conversations');
  const { rerender } = render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} searchFilter="x" /></SessionPinsProvider>);
  await openOptions('Title a');
  const unpin = await screen.findByRole('menuitem', { name: 'Unpin' });
  await waitFor(() => assert.equal(unpin.hasAttribute('disabled'), false));
  assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false);
  assert.ok(screen.getByText('Title a'), 'a one-character query must not hide pins when recents is still visible');
  rerender(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} searchMode="archived" /></SessionPinsProvider>);
  assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false);
});

test('pins outside the loaded recent page still render; loading older conversations keeps its pagination callback', async () => {
  const props = contentProps('conversations');
  props.recentConversations = [B];
  props.recentConversationsHasMore = true;
  const more = vi.fn();
  props.onLoadMoreRecentConversations = more;
  render(<SessionPinsProvider projects={EMPTY_PROJECTS}><SidebarContent {...props} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  assert.ok(screen.getByText('Title a'));
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  assert.equal(more.mock.calls.length, 1);
});

test('one bulk selection spans the Pinned and Recent groups', async () => {
  mocks.touch = true;
  const select = vi.fn();
  const props = contentProps('conversations');
  props.projectListProps = { ...listProps,
    sessionSelection: { projectId: RECENT_SESSIONS_SELECTION_SCOPE, sessionIds: new Set(['a']) }, onSetSessionSelection: select };
  render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...props} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByTestId('pinned-sessions-section')));
  // A single bar, above both groups.
  const bar = screen.getByRole('button', { name: 'sessions.selectAll' });
  const pinned = screen.getByTestId('pinned-sessions-section');
  assert.ok(bar.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING);
  fireEvent.click(bar);
  assert.deepEqual([...select.mock.calls[select.mock.calls.length - 1][0].sessionIds], ['a', 'b']);
});

test('an older in-flight refresh cannot reinsert a session after unpin', async () => {
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.ready, true));
  const stale = deferred<ReturnType<typeof response>>();
  mocks.load.mockReturnValueOnce(stale.promise);
  let oldRead!: Promise<void>;
  act(() => { oldRead = result.current!.refresh(); });
  await act(async () => { await result.current!.setPinned('a', false); });
  await act(async () => { stale.resolve(response([A])); await oldRead; });
  assert.deepEqual(result.current?.sessions, []);
});

test('a failed save keeps the original pin and exposes a retryable error', async () => {
  vi.spyOn(console, 'error').mockImplementation(noop);
  mocks.save.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.ready, true));
  await act(async () => { await result.current!.setPinned('a', false); });
  assert.equal(result.current?.pinnedIds.has('a'), true);
  assert.equal(result.current?.hasError, true);
  assert.equal(result.current?.pendingSessionId, null);
  await act(async () => { await result.current!.refresh(); });
  assert.equal(result.current?.hasError, false);
});

test('a failed initial load shows a retry notice even with no pinned sessions', async () => {
  vi.spyOn(console, 'error').mockImplementation(noop);
  mocks.load.mockRejectedValueOnce(new Error('offline'));
  render(<SessionPinsProvider projects={PROJECTS}><SidebarContent {...contentProps('projects')} /></SessionPinsProvider>);
  await waitFor(() => assert.ok(screen.queryByRole('alert')));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => assert.equal(Boolean(screen.queryByRole('alert')), false));
  await waitFor(() => assert.deepEqual(glyphIds(screen.getByTestId('project-session-tree')), ['a']));
  assert.equal(Boolean(screen.queryByTestId('pinned-sessions-section')), false);
});

test('double taps serialize mutations and a focus refresh picks up another device\'s pins', async () => {
  const { result } = renderHook(() => useSessionPins(), { wrapper });
  await waitFor(() => assert.equal(result.current?.ready, true));
  const save = deferred<ReturnType<typeof response>>();
  mocks.save.mockReturnValueOnce(save.promise);
  let first!: Promise<void>;
  act(() => { first = result.current!.setPinned('a', false); void result.current!.setPinned('a', false); });
  assert.equal(mocks.save.mock.calls.length, 1);
  assert.equal(result.current?.pendingSessionId, 'a');
  await act(async () => { save.resolve(response([])); await first; });
  mocks.load.mockResolvedValue(response([B]));
  fireEvent(window, new Event('focus'));
  await waitFor(() => assert.deepEqual(result.current?.sessions, [B]));
});

test('standalone recent rows keep their menu, without Pin, outside a pin provider', async () => {
  render(<SidebarRecentConversations conversations={[A]} total={1} hasMore={false} isLoading={false}
    isLoadingMore={false} hasError={false} selectedSession={null} currentTime={NOW} sessionActions={actions}
    bulkSelection={listProps} onConversationSelect={noop} onLoadMore={noop} onRetry={noop} t={t} />);
  assert.ok(screen.getByText('Title a'));
  await openOptions('Title a');
  assert.ok(screen.getByRole('menuitem', { name: 'Archive' }));
  assert.equal(screen.queryByRole('menuitem', { name: 'Pin' }), null);
});

test('Running stays view only: no Pin item, and ended off-page pins are not put back', async () => {
  mocks.load.mockResolvedValue(response([B]));
  const runningProjects: Project[] = [{ ...PROJECTS[0], sessions: [PROJECTS[0].sessions![0]],
    sessionMeta: { total: 1, hasMore: false } }];
  const props = contentProps('projects');
  props.searchMode = 'running';
  props.projectListProps = { ...listProps, filteredProjects: runningProjects,
    activeSessions: new Set(['a']), backgroundSessionIds: new Set(['a']) };
  function PinReadiness() {
    return <span>{useSessionPins()?.ready ? 'pins ready' : 'pins loading'}</span>;
  }
  render(<SessionPinsProvider projects={PROJECTS}><PinReadiness /><SidebarContent {...props} /></SessionPinsProvider>);
  await screen.findByText('pins ready');
  assert.equal(Boolean(screen.queryByText('Title b')), false);
  assert.deepEqual(treeIds(screen.getByTestId('project-session-tree')), ['a']);
  await openOptions('Title a');
  assert.equal(screen.queryByRole('menuitem', { name: 'Pin' }), null);
  assert.equal(screen.queryByRole('menuitem', { name: 'Unpin' }), null);
});

test('an off-page pinned child supplies ancestry without a loaded descendant and keeps loaded metadata authoritative', async () => {
  const projects: Project[] = [{ ...PROJECTS[0], sessions: [
    { id: 'newest', summary: 'Newest', __provider: 'codex' },
    { id: 'a', summary: 'Current parent title', __provider: 'codex' },
  ], sessionMeta: { total: 30, hasMore: true } }];
  const child = { ...B, forkedFromSessionId: 'a', forkAncestors: [
    { id: 'a', summary: 'Stale parent title', provider: 'codex' as const, forkedFromSessionId: null },
  ] };
  mocks.load.mockResolvedValue(response([child]));
  const props = contentProps('projects');
  props.projectListProps = { ...listProps, projects, filteredProjects: projects };
  render(<SessionPinsProvider projects={projects}><SidebarContent {...props} /></SessionPinsProvider>);
  const tree = screen.getByTestId('project-session-tree');
  await waitFor(() => assert.deepEqual(glyphIds(tree), ['b']));
  assert.deepEqual([...tree.querySelectorAll('[data-session-id]')].map((row) => [
    row.getAttribute('data-session-id'), row.getAttribute('data-parent-session-id'), row.getAttribute('data-fork-depth'),
  ]), [['a', null, '0'], ['b', 'a', '1'], ['newest', null, '0']]);
  assert.ok(screen.getByText('Current parent title'));
  assert.equal(Boolean(screen.queryByText('Stale parent title')), false);
});

test('polls coalesce behind a slow initial read instead of starving pin readiness', async () => {
  vi.useFakeTimers();
  const read = deferred<ReturnType<typeof response>>();
  mocks.load.mockReturnValue(read.promise);
  const { result, unmount } = renderHook(() => useSessionPins(), { wrapper });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    assert.equal(mocks.load.mock.calls.length, 1);
    await act(async () => { read.resolve(response([A])); });
    assert.equal(result.current?.ready, true);
    assert.deepEqual(result.current?.sessions, [A]);
  } finally { unmount(); vi.useRealTimers(); }
});

test('a timed-out save clears pending state and permits a subsequent explicit save', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(noop);
  mocks.save.mockImplementationOnce((_id, _pinned, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
  }));
  const { result, unmount } = renderHook(() => useSessionPins(), { wrapper });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    assert.equal(result.current?.ready, true);
    let save!: Promise<void>;
    act(() => { save = result.current!.setPinned('a', false); });
    assert.equal(result.current?.pendingSessionId, 'a');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await save; });
    assert.equal(result.current?.pendingSessionId, null);
    assert.equal(result.current?.hasError, true);
    assert.equal(result.current?.pinnedIds.has('a'), true);
    await act(async () => { await result.current!.setPinned('a', false); });
    assert.equal(result.current?.hasError, false);
    assert.equal(result.current?.pinnedIds.has('a'), false);
    assert.equal(mocks.save.mock.calls.length, 2);
  } finally { unmount(); vi.useRealTimers(); }
});
