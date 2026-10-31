import { cn } from '@/shared/utils';

type SwitchProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Ties the switch to a visible description, such as the hint under its label. */
  ariaDescribedBy?: string;
};

/**
 * The app's on/off switch. Used by the settings module's appearance, agents,
 * browser-use, tasks and voice tabs for boolean settings, and by the chat
 * module's prompt-preset editor for "Available in all projects".
 */
export function Switch({ checked, onChange, ariaLabel, disabled, ariaDescribedBy }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 flex-shrink-0 touch-manipulation cursor-pointer items-center rounded-full border-2 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked ? 'border-primary bg-primary' : 'border-border bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-5 w-5 rounded-full shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[22px] bg-white' : 'translate-x-[2px] bg-foreground/60 dark:bg-foreground/80',
        )}
      />
    </button>
  );
}
