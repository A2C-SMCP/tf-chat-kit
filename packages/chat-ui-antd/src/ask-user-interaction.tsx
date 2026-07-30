import {
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Radio,
  Space,
  Typography,
} from "antd";
import { Fragment, useCallback, useState } from "react";

import type {
  AskUserInteractionAnswer,
  AskUserInteractionQuestion,
  AskUserInteractionRequest,
  AskUserInteractionResult,
} from "@turingfocus/chat-protocol";
import { ASK_USER_MAX_TEXT_CHARACTERS } from "@turingfocus/chat-protocol";

import type { ChatUiLabels } from "./types.js";

interface AskUserFormValues {
  readonly answers?: readonly unknown[] | undefined;
}

export interface AskUserInteractionCardProps {
  readonly answerDisabled: boolean;
  readonly labels: ChatUiLabels;
  readonly onAnswer: (answer: AskUserInteractionAnswer) => Promise<boolean>;
  readonly onChatAboutThis?:
    ((request: AskUserChatAboutThisRequest) => void) | undefined;
  readonly request: AskUserInteractionRequest;
}

export interface AskUserChatAboutThisRequest {
  readonly answers: AskUserInteractionAnswer["answers"];
  readonly conversationId: string;
  readonly question: AskUserInteractionQuestion;
  readonly questionId: string;
  readonly requestId: string;
  readonly revision: string;
}

const normalizeAnswers = (
  values: readonly unknown[] | undefined,
  questions: readonly AskUserInteractionQuestion[],
): AskUserInteractionAnswer["answers"] => {
  const entries: Array<readonly [string, string | readonly string[]]> = [];
  questions.forEach((question, index) => {
    const value = values?.[index];
    if (Array.isArray(value)) {
      entries.push([question.id, value.map(String)]);
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      entries.push([question.id, String(value)]);
    }
  });
  return Object.fromEntries(entries);
};

export const AskUserInteractionCard = ({
  answerDisabled,
  labels,
  onAnswer,
  onChatAboutThis,
  request,
}: AskUserInteractionCardProps) => {
  const [form] = Form.useForm<AskUserFormValues>();
  const [submitting, setSubmitting] = useState(false);

  const answer = useCallback(
    async (
      action: AskUserInteractionAnswer["action"],
      values: AskUserFormValues = {},
    ): Promise<void> => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await onAnswer({
          requestId: request.requestId,
          revision: request.revision,
          action,
          answers:
            action === "cancel"
              ? {}
              : normalizeAnswers(values.answers, request.questions),
        });
      } finally {
        setSubmitting(false);
      }
    },
    [
      onAnswer,
      request.questions,
      request.requestId,
      request.revision,
      submitting,
    ],
  );

  const initialAnswers = request.questions.map((question) =>
    question.defaultValue === undefined
      ? undefined
      : question.multiple
        ? Array.isArray(question.defaultValue)
          ? question.defaultValue
          : [question.defaultValue]
        : Array.isArray(question.defaultValue)
          ? question.defaultValue[0]
          : question.defaultValue,
  );

  return (
    <Card aria-label={labels.askUserLabel} size="small" title={request.title}>
      {answerDisabled ? (
        <Typography.Paragraph type="secondary">
          {labels.askUserUnavailable}
        </Typography.Paragraph>
      ) : null}
      <Form<AskUserFormValues>
        form={form}
        initialValues={{ answers: initialAnswers }}
        layout="vertical"
        onFinish={(values) => answer("submit", values)}
      >
        {request.questions.map((question, questionIndex) => (
          <Fragment key={question.id}>
            <Form.Item
              label={
                <Space direction="vertical" size={0}>
                  {question.title === undefined ? null : (
                    <Typography.Text strong>{question.title}</Typography.Text>
                  )}
                  <Typography.Text>{question.prompt}</Typography.Text>
                </Space>
              }
              name={["answers", questionIndex]}
              {...(question.description === undefined
                ? {}
                : {
                    extra: (
                      <Typography.Text type="secondary">
                        {question.description}
                      </Typography.Text>
                    ),
                  })}
              {...(question.required
                ? {
                    rules: [
                      { required: true, message: labels.askUserRequired },
                    ],
                  }
                : {})}
            >
              {question.options.length === 0 ? (
                <Input.TextArea
                  disabled={answerDisabled || submitting}
                  maxLength={ASK_USER_MAX_TEXT_CHARACTERS}
                  placeholder={question.placeholder}
                />
              ) : question.multiple ? (
                <Checkbox.Group
                  disabled={answerDisabled || submitting}
                  options={question.options.map((option) => ({
                    label:
                      option.description === undefined
                        ? option.label
                        : `${option.label} — ${option.description}`,
                    value: option.value,
                  }))}
                />
              ) : (
                <Radio.Group
                  disabled={answerDisabled || submitting}
                  options={question.options.map((option) => ({
                    label:
                      option.description === undefined
                        ? option.label
                        : `${option.label} — ${option.description}`,
                    value: option.value,
                  }))}
                />
              )}
            </Form.Item>
            {onChatAboutThis === undefined ? null : (
              <Button
                disabled={submitting}
                onClick={() => {
                  onChatAboutThis({
                    answers: normalizeAnswers(
                      form.getFieldsValue().answers,
                      request.questions,
                    ),
                    conversationId: request.conversationId,
                    question,
                    questionId: question.id,
                    requestId: request.requestId,
                    revision: request.revision,
                  });
                }}
                type="link"
              >
                {labels.askUserChatAboutThis}
              </Button>
            )}
          </Fragment>
        ))}
        <Space wrap>
          <Button
            disabled={answerDisabled}
            htmlType="submit"
            loading={submitting}
            type="primary"
          >
            {submitting ? labels.askUserSubmitting : labels.askUserSubmit}
          </Button>
          <Button
            disabled={answerDisabled || submitting}
            onClick={() => answer("cancel")}
          >
            {labels.askUserCancel}
          </Button>
        </Space>
      </Form>
    </Card>
  );
};

export interface AskUserInteractionResultViewProps {
  readonly result: AskUserInteractionResult;
}

export const AskUserInteractionResultView = ({
  result,
}: AskUserInteractionResultViewProps) => {
  const questionLimit = 12;
  const textLimit = 800;
  const answerValueLimit = 50;
  const visibleQuestions = result.questions.slice(0, questionLimit);
  let truncated = visibleQuestions.length < result.questions.length;
  const truncate = (value: string): string => {
    if (value.length <= textLimit) return value;
    truncated = true;
    return `${value.slice(0, textLimit)}… [truncated]`;
  };
  const renderedQuestions = visibleQuestions.map((question) => {
    const answer = result.answers?.[question.id];
    let answerText: string | undefined;
    if (typeof answer === "string") {
      answerText = truncate(answer);
    } else if (answer !== undefined) {
      const visibleValues = answer.slice(0, answerValueLimit);
      if (visibleValues.length < answer.length) truncated = true;
      answerText = truncate(visibleValues.join(", "));
    }
    return (
      <div key={question.id}>
        <Typography.Text>{truncate(question.prompt)}</Typography.Text>
        {answerText === undefined ? null : (
          <Typography.Paragraph style={{ margin: 0 }} type="secondary">
            {answerText}
          </Typography.Paragraph>
        )}
      </div>
    );
  });
  const error = result.error === undefined ? undefined : truncate(result.error);
  return (
    <Space direction="vertical" size="small">
      <Typography.Text strong>Ask User · {result.status}</Typography.Text>
      {renderedQuestions}
      {error === undefined ? null : (
        <Typography.Text type="danger">{error}</Typography.Text>
      )}
      {truncated ? (
        <Typography.Text type="secondary">
          Ask User history truncated
        </Typography.Text>
      ) : null}
    </Space>
  );
};
