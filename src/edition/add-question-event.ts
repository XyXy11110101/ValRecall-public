// Lets the empty Review page ask for the add form without a prop through three shared components.
const ADD_QUESTION_EVENT = 'valrecall:add-question';

export function requestAddQuestion(): void {
  window.dispatchEvent(new Event(ADD_QUESTION_EVENT));
}

export function onAddQuestionRequested(listener: () => void): () => void {
  window.addEventListener(ADD_QUESTION_EVENT, listener);
  return () => window.removeEventListener(ADD_QUESTION_EVENT, listener);
}
