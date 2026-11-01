import { isRecord } from '../sync/protocol';

declare global {
  interface Window {
    ValRecallNative?: { request: (json: string) => void };
  }
}

export type NativeRequestType =
  | 'pair.scan'
  | 'pair.import'
  | 'pair.status'
  | 'pair.forget'
  | 'sync'
  | 'widget.publish'
  | 'navigation.consume'
  | 'navigation.inputReady';

export class NativeBridgeError extends Error {
  constructor(
    message: string,
    readonly code = 'UNAVAILABLE',
  ) {
    super(message);
  }
}

export function nativeRequest(type: NativeRequestType, payload: unknown = {}): Promise<unknown> {
  const native = window.ValRecallNative;
  if (!native) return Promise.reject(new Error('请在 ValRecall Android App 中使用配对和同步。'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener('valrecall-native-result', listener);
    };
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
      let value: unknown;
      try {
        value = JSON.parse(event.detail);
      } catch {
        return;
      }
      if (!isRecord(value) || value.id !== id || typeof value.ok !== 'boolean') return;
      finish();
      if (value.ok) resolve(value.payload);
      else {
        const error = value.error;
        reject(
          new NativeBridgeError(
            typeof error === 'string'
              ? error
              : isRecord(error) && typeof error.message === 'string'
                ? error.message
                : '连接失败，请重试。',
            isRecord(error) && typeof error.code === 'string' ? error.code : 'UNAVAILABLE',
          ),
        );
      }
    };
    // Camera/permission dialogs need user time; a killed process never acknowledges an operation.
    const timer = setTimeout(
      () => {
        finish();
        reject(new Error('连接超时，请重试。'));
      },
      type.startsWith('widget.') || type.startsWith('navigation.') ? 10_000 : 120_000,
    );
    window.addEventListener('valrecall-native-result', listener);
    try {
      native.request(JSON.stringify({ id, type, payload }));
    } catch {
      finish();
      reject(new Error('连接失败，请重新打开 App。'));
    }
  });
}
