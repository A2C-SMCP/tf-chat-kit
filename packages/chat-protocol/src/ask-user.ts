import type {
  AskUserInteractionAnswer,
  AskUserInteractionQuestion,
  AskUserInteractionRequest,
  AskUserInteractionValue,
} from "./models.js";

export const ASK_USER_MAX_ANSWER_VALUES = 100;
export const ASK_USER_MAX_OPTIONS = 100;
export const ASK_USER_MAX_QUESTIONS = 20;
export const ASK_USER_MAX_QUESTION_ID_CHARACTERS = 256;
export const ASK_USER_MAX_REQUEST_ID_CHARACTERS = 256;
export const ASK_USER_MAX_TEXT_CHARACTERS = 2_000;

const reservedQuestionIds = new Set(["__proto__", "constructor", "prototype"]);

export const isSafeAskUserQuestionId = (value: string): boolean =>
  value.length > 0 && !reservedQuestionIds.has(value);

const valueParts = (value: AskUserInteractionValue): readonly string[] =>
  typeof value === "string" ? [value] : value;

export const isAskUserInteractionValueCompatible = (
  question: AskUserInteractionQuestion,
  value: AskUserInteractionValue,
): boolean => {
  if (question.multiple !== Array.isArray(value)) return false;
  const parts = valueParts(value);
  if (
    question.required &&
    (parts.length === 0 || parts.some((part) => part.length === 0))
  ) {
    return false;
  }
  if (question.options.length === 0) return true;
  const allowedValues = new Set(question.options.map((option) => option.value));
  return parts.every((part) => allowedValues.has(part));
};

export const getAskUserInteractionAnswerValidationError = (
  request: AskUserInteractionRequest,
  answer: AskUserInteractionAnswer,
): string | undefined => {
  if (answer.action !== "submit") return undefined;
  const questions = new Map(
    request.questions.map((question) => [question.id, question]),
  );
  if (
    Object.keys(answer.answers).some((questionId) => !questions.has(questionId))
  ) {
    return "Interaction answers contain an unknown question";
  }

  for (const question of request.questions) {
    if (!Object.hasOwn(answer.answers, question.id)) {
      if (question.required) {
        return "Interaction answers omit a required question";
      }
      continue;
    }
    const value = answer.answers[question.id];
    if (
      typeof value !== "string" &&
      (!Array.isArray(value) ||
        value.some((candidate) => typeof candidate !== "string"))
    ) {
      return "Interaction answer values must be strings";
    }
    if (!isAskUserInteractionValueCompatible(question, value)) {
      return "Interaction answer values do not match their question";
    }
  }
  return undefined;
};
