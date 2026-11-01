import { isRecord } from './protocol';

export const SYNC_DATA_CHANGED = { version: 1, type: 'VALRECALL_SYNC_DATA_CHANGED' } as const;

export function subscribeSyncDataChanged(onChange: () => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return () => undefined;
  const runtime = chrome.runtime;
  const receive = (value: unknown, sender: chrome.runtime.MessageSender) => {
    if (
      sender.id === runtime.id &&
      !sender.tab &&
      isRecord(value) &&
      value.version === 1 &&
      value.type === SYNC_DATA_CHANGED.type
    )
      onChange();
  };
  runtime.onMessage.addListener(receive);
  return () => runtime.onMessage.removeListener(receive);
}
