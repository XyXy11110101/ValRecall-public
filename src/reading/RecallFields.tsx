import type { Ref } from 'react';

export function RecallFields({
  prompt,
  answer,
  onPrompt,
  onAnswer,
  promptRef,
  answerRef,
}: {
  prompt: string;
  answer: string;
  onPrompt: (value: string) => void;
  onAnswer: (value: string) => void;
  promptRef?: Ref<HTMLTextAreaElement>;
  answerRef?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <>
      <label className="field">
        <span>回忆问题</span>
        <textarea
          ref={promptRef}
          rows={3}
          required
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
          placeholder="不看原文时，你想问自己什么？"
        />
      </label>
      <label className="field">
        <span>答案要点</span>
        <textarea
          ref={answerRef}
          rows={4}
          required
          value={answer}
          onChange={(event) => onAnswer(event.target.value)}
          placeholder="写下核对答案时最重要的几点。"
        />
      </label>
    </>
  );
}
