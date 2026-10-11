import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the effort control. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the model control. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
};

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultracode: 'Ultracode',
};

const effortName = (value: string) => EFFORT_LABELS[value] ?? value;

/**
 * The catalog option a model id stands for. Sessions record the full id
 * (`claude-opus-5-5`) while the catalog lists aliases (`opus`), so an option
 * also matches the id it resolves to; a named alias wins over Default.
 */
const findModelOption = (options: ProviderModelOption[], model: string): ProviderModelOption | null =>
  options.find((option) => option.value === model)
  ?? options.find((option) => option.value !== 'default' && option.resolvesTo === model)
  ?? options.find((option) => option.resolvesTo === model)
  ?? null;

/** "claude-opus-4-8" reads "Opus 4.8" when the catalog does not know the id. */
const readableModelName = (model: string): string => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|$)/.exec(model);
  if (!match) {
    return model;
  }
  const [, family, major, minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`;
};

const TRIGGER_CLASS =
  'flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent aria-expanded:bg-accent';

/** Width of the "More models" flyout, which opens beside the menu. */
const FLYOUT_WIDTH = 200;

/** The model picker: current models with number shortcuts, earlier ones under "More models". */
function ModelPicker({
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
}: Pick<ComposerModelMenuProps, 'model' | 'modelOptions' | 'onSelectModel' | 'modelsLoading'>) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [flyout, setFlyout] = useState<{ left: number; bottom: number } | null>(null);
  const moreRowRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 280);

  const primaryOptions = useMemo(() => modelOptions.filter((option) => option.group !== 'more'), [modelOptions]);
  const moreOptions = useMemo(() => modelOptions.filter((option) => option.group === 'more'), [modelOptions]);
  const selectedOption = findModelOption(modelOptions, model);
  const triggerLabel = selectedOption?.label || readableModelName(model);
  const ariaLabel = t('composer.modelMenu', { defaultValue: 'Select model' });

  const select = useCallback((value: string) => {
    onSelectModel(value);
    setIsOpen(false);
  }, [onSelectModel]);

  useEffect(() => {
    if (!isOpen) {
      setFlyout(null);
      return undefined;
    }
    // Number keys pick a model while the menu is open, as in Claude Code.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < Math.min(9, primaryOptions.length)) {
        event.preventDefault();
        select(primaryOptions[index].value);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, primaryOptions, select]);

  const toggleFlyout = () => {
    if (flyout) {
      setFlyout(null);
      return;
    }
    const rect = moreRowRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // Beside the menu, on whichever side has room; it grows upward from the row.
    const fitsRight = rect.right + 4 + FLYOUT_WIDTH <= window.innerWidth - 8;
    setFlyout({
      left: fitsRight ? rect.right + 4 : Math.max(8, rect.left - 4 - FLYOUT_WIDTH),
      bottom: Math.max(8, window.innerHeight - rect.bottom - 4),
    });
  };

  if (modelOptions.length === 0 && !modelsLoading) {
    return null;
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className={cn(TRIGGER_CLASS, 'max-w-28 sm:max-w-56')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={selectedOption?.description || ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {modelOptions.length === 0 && (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
              {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
            </p>
          )}
          {primaryOptions.map((option, index) => (
            <ComposerMenuItem
              key={option.value}
              label={option.label || option.value}
              isSelected={option === selectedOption}
              onSelect={() => select(option.value)}
              trailing={option === selectedOption
                ? <Check className="h-3.5 w-3.5 text-[#4176ce]" />
                : index < 9 ? <span className="text-xs text-muted-foreground">{index + 1}</span> : null}
            />
          ))}

          {moreOptions.length > 0 && (
            <>
              <ComposerMenuSeparator />
              <button
                ref={moreRowRef}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={Boolean(flyout)}
                onClick={toggleFlyout}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground/90 transition-colors hover:bg-accent aria-expanded:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">
                  {t('composer.moreModels', { defaultValue: 'More models' })}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </button>

              {/* Fixed, but inside the menu's DOM, so a click in it is not a click outside. */}
              {flyout && (
                <div
                  role="menu"
                  aria-label={t('composer.moreModels', { defaultValue: 'More models' })}
                  className="fixed z-[101] max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                  style={{ left: flyout.left, bottom: flyout.bottom, width: FLYOUT_WIDTH }}
                >
                  {moreOptions.map((option) => (
                    <ComposerMenuItem
                      key={option.value}
                      label={option.label || option.value}
                      isSelected={option === selectedOption}
                      onSelect={() => select(option.value)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** The effort control: a Faster–Smarter slider over the model's levels, as in Claude Code. */
function EffortPicker({
  effort,
  effortOptions,
  defaultEffort,
  onSelectEffort,
}: Pick<ComposerModelMenuProps, 'effort' | 'effortOptions' | 'onSelectEffort'> & { defaultEffort: string | null }) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 300);

  const isDefault = effort === DEFAULT_EFFORT_VALUE;
  // The level actually in force: the chosen one, or what Default stands for.
  const activeEffort = isDefault ? defaultEffort : effort;
  const defaultLabel = defaultEffort
    ? t('composer.effortDefaultNamed', { effort: effortName(defaultEffort), defaultValue: 'Default ({{effort}})' })
    : t('composer.effortDefault', { defaultValue: 'Default' });
  const currentLabel = isDefault ? defaultLabel : effortName(effort);
  const ariaLabel = t('composer.effortMenu', { defaultValue: 'Select effort' });

  if (effortOptions.length === 0) {
    return null;
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className={cn(TRIGGER_CLASS, 'max-w-28 sm:max-w-40')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`${ariaLabel}: ${currentLabel}`}
        title={ariaLabel}
      >
        <span className="truncate">{currentLabel}</span>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <div className="w-[17rem] max-w-full px-2.5 pb-1 pt-1.5">
            <p className="text-sm">
              <span className="text-muted-foreground">{t('composer.effort', { defaultValue: 'Effort' })}</span>
              <span className="ml-1.5 font-medium text-foreground">{currentLabel}</span>
            </p>
            <div className="mt-3 flex justify-between text-xs text-muted-foreground">
              <span>{t('composer.effortFaster', { defaultValue: 'Faster' })}</span>
              <span>{t('composer.effortSmarter', { defaultValue: 'Smarter' })}</span>
            </div>
            <div
              role="radiogroup"
              aria-label={ariaLabel}
              className="mt-1.5 flex h-8 items-center rounded-full bg-muted px-1"
            >
              {effortOptions.map((option) => {
                const isActive = option.value === activeEffort;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={!isDefault && option.value === effort}
                    aria-label={effortName(option.value)}
                    title={option.description || effortName(option.value)}
                    onClick={() => onSelectEffort(option.value)}
                    className="group flex h-full flex-1 items-center justify-center focus-visible:outline-none"
                  >
                    {isActive ? (
                      <span className="h-6 w-4 rounded-full bg-background shadow ring-1 ring-border group-focus-visible:ring-2 group-focus-visible:ring-ring" />
                    ) : (
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/50 transition-transform group-hover:scale-150" />
                    )}
                  </button>
                );
              })}
            </div>
            {/* "Recommended" sits under the model's default level. */}
            <div className="mt-1 flex text-[11px] text-muted-foreground">
              {effortOptions.map((option) => (
                <span key={option.value} className="flex-1 whitespace-nowrap text-center">
                  {option.value === defaultEffort ? t('composer.effortRecommended', { defaultValue: 'Recommended' }) : ''}
                </span>
              ))}
            </div>
          </div>
          <ComposerMenuSeparator />
          <ComposerMenuItem
            label={defaultLabel}
            isSelected={isDefault}
            onSelect={() => {
              onSelectEffort(DEFAULT_EFFORT_VALUE);
              setIsOpen(false);
            }}
          />
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/**
 * Rendered by chat's ChatComposer: the model and effort controls for the next
 * turn, side by side as in Claude Code. Default choices say what they stand
 * for ("Default (Sonnet 5.5)", "Default (High)").
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
}: ComposerModelMenuProps) {
  const selectedOption = findModelOption(modelOptions, model);
  const defaultEffort = selectedOption?.effort?.default
    ?? (effortOptions.some((option) => option.value === 'high') ? 'high' : null);

  return (
    <div className="flex items-center">
      <ModelPicker
        model={model}
        modelOptions={modelOptions}
        onSelectModel={onSelectModel}
        modelsLoading={modelsLoading}
      />
      <EffortPicker
        effort={effort}
        effortOptions={effortOptions}
        defaultEffort={defaultEffort}
        onSelectEffort={onSelectEffort}
      />
    </div>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of these props change while typing. */
export default memo(ComposerModelMenu);
