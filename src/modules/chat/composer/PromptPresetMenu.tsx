import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BookMarked, BookmarkPlus, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react';

import { confirmDialog } from '@/shared/ui';
import type { PromptPreset } from '@/shared/types';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { usePromptPresets } from '@/modules/chat/hooks/usePromptPresets';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import PromptPresetEditorDialog from '@/modules/chat/modals/PromptPresetEditorDialog';

/** Above this many presets the menu offers a search field. */
const SEARCH_THRESHOLD = 5;

/** The menu's width where the window allows it; narrower on a phone. */
const MENU_WIDTH = 22 * 16;

/** Everything the arrow keys move between: the search field, the presets and the footer actions. */
const NAVIGABLE_SELECTOR = '[data-preset-search], [role="menuitem"]:not([disabled])';

type PromptPresetMenuProps = {
  projectId: string;
  /** Whether the message box holds text, which "Save message as preset" needs. */
  hasMessage: boolean;
  /** Reads the message box's text when it is saved as a preset; a getter, so typing does not re-render the menu. */
  readMessage: () => string;
  /** Puts a picked preset's text in the message box at the caret. */
  onInsert: (text: string) => void;
};

type EditorState = {
  /** Remounts the editor for each opening, so its form starts fresh. */
  key: number;
  mode: 'create' | 'edit';
  presetId: string | null;
  initial: Pick<PromptPreset, 'title' | 'content' | 'global'>;
};

/** One line of the prompt, as the row previews it. */
const previewOf = (content: string) => content.replace(/\s+/g, ' ').trim();

/**
 * Rendered by chat's ChatComposer in the toolbar under the message box when a
 * project is open: the project's saved prompts (its own and the ones offered in
 * every project) to drop into the message box, plus writing, changing and
 * deleting them. Picking one inserts its text; it never sends.
 */
function PromptPresetMenu({ projectId, hasMessage, readMessage, onInsert }: PromptPresetMenuProps) {
  const { t } = useTranslation('chat');
  const {
    presets,
    isLoading,
    error,
    clearError,
    createPreset,
    updatePreset,
    removePreset,
    markPresetUsed,
  } = usePromptPresets(projectId);
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, MENU_WIDTH);
  // The search text; it narrows the list by title and prompt.
  const [query, setQuery] = useState('');
  // The editor's opening, or null while it is closed. The menu closes while
  // the editor is up and opens again when it is done, back where the user was.
  const [editor, setEditor] = useState<EditorState | null>(null);
  const editorCountRef = useRef(0);

  const showSearch = presets.length > SEARCH_THRESHOLD;
  const normalizedQuery = showSearch ? query.trim().toLowerCase() : '';
  const visiblePresets = useMemo(() => {
    if (!normalizedQuery) return presets;
    return presets.filter((preset) =>
      preset.title.toLowerCase().includes(normalizedQuery)
      || preset.content.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, presets]);

  // Each opening starts unfiltered.
  const openMenu = useCallback(() => {
    setQuery('');
    updateAnchor();
    setIsOpen(true);
  }, [updateAnchor]);

  // The focus goes into the menu on opening so the arrow keys work at once: in
  // the search field where there is one (not on a touch screen, where that
  // would raise the keyboard), else on the first preset.
  useEffect(() => {
    if (!isOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    const isTouch = window.matchMedia?.('(hover: none)').matches ?? false;
    const search = isTouch ? null : menu.querySelector<HTMLElement>('[data-preset-search]');
    (search ?? menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])'))?.focus();
  }, [isOpen, menuRef]);

  const pick = (preset: PromptPreset) => {
    setIsOpen(false);
    onInsert(preset.content);
    void markPresetUsed(preset.id);
  };

  // The menu gives way to the editor or the delete confirmation, with the
  // focus on its button so it is not lost while the menu is gone.
  const stepAway = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const openEditor = (mode: EditorState['mode'], presetId: string | null, initial: EditorState['initial']) => {
    stepAway();
    clearError();
    editorCountRef.current += 1;
    setEditor({ key: editorCountRef.current, mode, presetId, initial });
  };

  const closeEditor = useCallback(() => {
    setEditor(null);
    openMenu();
  }, [openMenu]);

  const saveEditor = async (draft: EditorState['initial']) => {
    if (!editor) return false;
    const saved = editor.mode === 'edit' && editor.presetId
      ? await updatePreset(editor.presetId, draft)
      : await createPreset(draft);
    if (!saved) return false;
    closeEditor();
    return true;
  };

  const confirmDelete = async (preset: PromptPreset) => {
    stepAway();
    const confirmed = await confirmDialog(
      t('promptPresets.deleteConfirm', { title: preset.title, defaultValue: 'Delete the preset “{{title}}”?' }),
      {
        destructive: true,
        confirmLabel: t('promptPresets.delete', { defaultValue: 'Delete' }),
        cancelLabel: t('promptPresets.editor.cancel', { defaultValue: 'Cancel' }),
      },
    );
    if (confirmed) {
      void removePreset(preset.id);
    }
    openMenu();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    const target = event.target as HTMLElement;

    // Enter in the search field picks the first match, as in a command palette.
    if (event.key === 'Enter' && target.hasAttribute('data-preset-search')) {
      event.preventDefault();
      if (visiblePresets[0]) pick(visiblePresets[0]);
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>(NAVIGABLE_SELECTOR));
    if (items.length === 0) return;
    event.preventDefault();
    // From a row's edit or delete button the arrows carry on from that row.
    const from = target.closest<HTMLElement>('[data-preset-item]')?.querySelector<HTMLElement>('[role="menuitem"]') ?? target;
    const index = items.indexOf(from);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const label = t('promptPresets.trigger', { defaultValue: 'Preset prompts' });
  const allProjectsLabel = t('promptPresets.allProjects', { defaultValue: 'All projects' });

  return (
    <>
      <PromptInputButton
        ref={triggerRef}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
            return;
          }
          openMenu();
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={label}
        title={label}
        className="aria-expanded:bg-accent"
      >
        <BookMarked />
      </PromptInputButton>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface
          anchor={anchor}
          menuRef={menuRef}
          ariaLabel={label}
          onKeyDown={handleMenuKeyDown}
          className="flex w-[22rem] flex-col overflow-hidden"
        >
          <ComposerMenuHeading>{label}</ComposerMenuHeading>

          {error && (
            <div role="alert" className="mx-1 mb-1 flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              <span className="min-w-0 flex-1 break-words">{error}</span>
              <button
                type="button"
                onClick={clearError}
                aria-label={t('promptPresets.dismissError', { defaultValue: 'Dismiss' })}
                className="shrink-0 rounded p-0.5 hover:bg-destructive/10"
              >
                <XIcon className="h-3 w-3" aria-hidden />
              </button>
            </div>
          )}

          {showSearch && (
            <div className="relative mx-1 mb-1 shrink-0">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                data-preset-search=""
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('promptPresets.searchPlaceholder', { defaultValue: 'Search presets' })}
                aria-label={t('promptPresets.searchPlaceholder', { defaultValue: 'Search presets' })}
                autoComplete="off"
                className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {isLoading && presets.length === 0 && (
              <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                {t('promptPresets.loading', { defaultValue: 'Loading presets…' })}
              </p>
            )}

            {!isLoading && presets.length === 0 && (
              <div className="flex flex-col items-center gap-1.5 px-4 py-5 text-center">
                <BookMarked className="h-5 w-5 text-muted-foreground/70" aria-hidden />
                <p className="text-balance text-sm text-muted-foreground">
                  {t('promptPresets.empty', { defaultValue: 'No presets yet — save prompts you reuse here' })}
                </p>
              </div>
            )}

            {presets.length > 0 && visiblePresets.length === 0 && (
              <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                {t('promptPresets.noMatches', { defaultValue: 'No presets match your search' })}
              </p>
            )}

            {visiblePresets.map((preset) => (
              <div
                key={preset.id}
                data-preset-item=""
                className="group relative rounded-lg transition-colors hover:bg-accent has-[:focus-visible]:bg-accent"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => pick(preset)}
                  // The full prompt on hover, since the row shows one line of it.
                  title={preset.content}
                  className="flex w-full min-w-0 flex-col rounded-lg px-2.5 py-1.5 pr-16 text-left text-sm text-foreground/90 focus-visible:outline-none"
                >
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <span className="truncate leading-5 text-foreground">{preset.title}</span>
                    {preset.global && (
                      <span className="shrink-0 rounded border border-border/70 px-1 text-[10px] font-medium leading-4 text-muted-foreground">
                        {allProjectsLabel}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block w-full truncate text-xs leading-4 text-muted-foreground">
                    {previewOf(preset.content)}
                  </span>
                </button>
                {/* Revealed on hover or keyboard focus; always shown where there is no hover. */}
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 touch:opacity-100">
                  <button
                    type="button"
                    onClick={() => openEditor('edit', preset.id, {
                      title: preset.title,
                      content: preset.content,
                      global: preset.global,
                    })}
                    aria-label={t('promptPresets.editNamed', { title: preset.title, defaultValue: 'Edit “{{title}}”' })}
                    title={t('promptPresets.edit', { defaultValue: 'Edit preset' })}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <PencilIcon className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmDelete(preset)}
                    aria-label={t('promptPresets.deleteNamed', { title: preset.title, defaultValue: 'Delete “{{title}}”' })}
                    title={t('promptPresets.delete', { defaultValue: 'Delete' })}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Trash2Icon className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <ComposerMenuSeparator />
          <div className="shrink-0">
            <ComposerMenuItem
              role="menuitem"
              icon={<PlusIcon className="h-4 w-4" />}
              label={t('promptPresets.newPreset', { defaultValue: 'New preset' })}
              isSelected={false}
              onSelect={() => openEditor('create', null, { title: '', content: '', global: false })}
            />
            <ComposerMenuItem
              role="menuitem"
              icon={<BookmarkPlus className="h-4 w-4" />}
              label={t('promptPresets.saveMessage', { defaultValue: 'Save message as preset' })}
              isSelected={false}
              disabled={!hasMessage}
              title={hasMessage ? undefined : t('promptPresets.saveMessageEmpty', {
                defaultValue: 'Type a message first',
              })}
              onSelect={() => openEditor('create', null, { title: '', content: readMessage().trim(), global: false })}
            />
          </div>
        </ComposerMenuSurface>,
        document.body,
      )}

      {editor && (
        <PromptPresetEditorDialog
          key={editor.key}
          open
          mode={editor.mode}
          initial={editor.initial}
          onSave={saveEditor}
          onClose={closeEditor}
          saveError={error}
        />
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(PromptPresetMenu);
