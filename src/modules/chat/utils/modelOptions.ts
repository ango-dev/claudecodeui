import type { ProviderModelOption } from '@/shared/types';

/**
 * Used by the composer's model menu and the chat provider state to find the
 * catalog option for a model, whether it is recorded as the option's value
 * ("opus") or as the full id an alias runs ("claude-opus-5-5"). A named alias
 * wins over Default when both run that id, matching the server's lookup.
 */
export const findModelOption = (options: ProviderModelOption[], model: string): ProviderModelOption | null =>
  options.find((option) => option.value === model)
  ?? options.find((option) => option.value !== 'default' && option.resolvesTo === model)
  ?? options.find((option) => option.resolvesTo === model)
  ?? null;
