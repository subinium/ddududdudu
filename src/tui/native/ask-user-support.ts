import type { AskUserOption, AskUserPrompt, AskUserQuestionKind, AskUserValidation } from '../../tools/index.js';

interface BaseAskUserPromptInput {
  question: string;
  kind?: AskUserQuestionKind;
  detail?: string;
  placeholder?: string;
  submitLabel?: string;
  required?: boolean;
  defaultValue?: string;
  validation?: AskUserValidation;
  options?: AskUserOption[];
}

const trimText = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeOptions = (options: AskUserOption[] = []): AskUserOption[] =>
  options
    .map((option) => {
      const value = trimText(option.value);
      if (!value) {
        return null;
      }

      return {
        value,
        ...(trimText(option.label) ? { label: trimText(option.label) } : {}),
        ...(trimText(option.description) ? { description: trimText(option.description) } : {}),
        ...(option.recommended === true ? { recommended: true } : {}),
        ...(option.danger === true ? { danger: true } : {}),
        ...(trimText(option.shortcut) ? { shortcut: trimText(option.shortcut) } : {}),
      };
    })
    .filter((option): option is AskUserOption => option !== null);

const normalizeValidation = (validation: AskUserValidation | undefined): AskUserValidation | undefined => {
  if (!validation || typeof validation !== 'object') {
    return undefined;
  }

  const normalized: AskUserValidation = {};
  if (typeof validation.pattern === 'string' && validation.pattern.trim().length > 0) {
    normalized.pattern = validation.pattern.trim();
  }
  if (typeof validation.minLength === 'number' && Number.isFinite(validation.minLength) && validation.minLength >= 0) {
    normalized.minLength = Math.floor(validation.minLength);
  }
  if (typeof validation.maxLength === 'number' && Number.isFinite(validation.maxLength) && validation.maxLength >= 0) {
    normalized.maxLength = Math.floor(validation.maxLength);
  }
  if (typeof validation.message === 'string' && validation.message.trim().length > 0) {
    normalized.message = validation.message.trim();
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const buildChoicePrompt = (input: BaseAskUserPromptInput): AskUserPrompt => ({
  question: input.question.trim(),
  kind: input.kind ?? 'single_select',
  detail: trimText(input.detail) ?? 'Choose one option to continue.',
  submitLabel: trimText(input.submitLabel) ?? 'Select',
  allowCustomAnswer: false,
  required: input.required !== false,
  defaultValue: trimText(input.defaultValue),
  validation: normalizeValidation(input.validation),
  options: normalizeOptions(input.options),
});

export const buildInputPrompt = (input: BaseAskUserPromptInput): AskUserPrompt => ({
  question: input.question.trim(),
  kind: input.kind ?? 'input',
  detail:
    trimText(input.detail)
    ?? (input.options?.length
      ? 'Suggested answers are optional. You can type your own response.'
      : undefined),
  placeholder: trimText(input.placeholder) ?? 'Type your answer',
  submitLabel: trimText(input.submitLabel) ?? 'Send answer',
  allowCustomAnswer: true,
  required: input.required !== false,
  defaultValue: trimText(input.defaultValue),
  validation: normalizeValidation(input.validation),
  options: normalizeOptions(input.options),
});
