/** Only fixed, reviewed messages may cross the native diagnostic boundary. */
export const NATIVE_CONNECTION_ERRORS = {
  'SYNC-UNKNOWN': '无法连接 Windows 同步助手。请先安装助手，并检查 Edge 扩展权限。',
  'SYNC-PERMISSION':
    'Edge 尚未允许连接电脑助手。请关闭手机同步后重新启用，并允许权限请求。[SYNC-PERMISSION]',
  'SYNC-DATA': '电脑本地同步身份读取失败；请保留数据，不要重装或清空。[SYNC-DATA]',
  'SYNC-TIMEOUT': '电脑助手未在限定时间内回应。[SYNC-TIMEOUT]',
  'SYNC-HOST-REQUEST': '电脑助手已启动，但没有完成当前连接或配对请求。[SYNC-HOST-REQUEST]',
  'SYNC-PROTOCOL': '电脑助手返回的连接信息格式不符合要求。[SYNC-PROTOCOL]',
  'SYNC-HOST-NOT-FOUND': 'Edge 没有找到或无法读取电脑助手的注册清单。[SYNC-HOST-NOT-FOUND]',
  'SYNC-HOST-DENIED': 'Edge 拒绝了此扩展连接电脑助手；不要更改安全策略。[SYNC-HOST-DENIED]',
  'SYNC-HOST-START': 'Edge 找到了电脑助手，但未能启动它。[SYNC-HOST-START]',
  'SYNC-HOST-EXIT': '电脑助手启动后提前退出。[SYNC-HOST-EXIT]',
} as const;

export type NativeConnectionErrorCode = keyof typeof NATIVE_CONNECTION_ERRORS;

export function isNativeConnectionErrorCode(value: unknown): value is NativeConnectionErrorCode {
  return typeof value === 'string' && Object.hasOwn(NATIVE_CONNECTION_ERRORS, value);
}

/** Do not retain or return the browser's raw error, which can contain local details. */
export function classifyNativeConnectionError(value: unknown): NativeConnectionErrorCode {
  const message =
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
      ? value.message
      : '';
  if (message.includes('Specified native messaging host not found')) return 'SYNC-HOST-NOT-FOUND';
  if (message.includes('Access to the specified native messaging host is forbidden'))
    return 'SYNC-HOST-DENIED';
  if (message.includes('Failed to start native messaging host')) return 'SYNC-HOST-START';
  if (message.includes('Native host has exited')) return 'SYNC-HOST-EXIT';
  if (message.includes('Error when communicating with the native messaging host'))
    return 'SYNC-PROTOCOL';
  return 'SYNC-UNKNOWN';
}
