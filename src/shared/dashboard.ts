import {
  isOpenDashboardResponse,
  isDashboardLibraryTarget,
  MESSAGE_PROTOCOL_VERSION,
  MESSAGE_TYPES,
  type OpenDashboardMessage,
  type OpenDashboardResponse,
  type DashboardLibraryTarget,
} from '../models/messages';
import { hasExtensionRuntime } from './extension';

/** Ask the service worker to focus the existing dashboard tab or create one. */
export async function openValRecallDashboard(
  target?: DashboardLibraryTarget,
): Promise<OpenDashboardResponse> {
  if (target !== undefined && !isDashboardLibraryTarget(target))
    return { ok: false, error: '无法打开这条记录。' };
  if (!hasExtensionRuntime()) {
    return {
      ok: false,
      error: 'The dashboard opener is available after ValRecall is loaded as an Edge extension.',
    };
  }

  const message: OpenDashboardMessage = {
    type: MESSAGE_TYPES.openDashboard,
    version: MESSAGE_PROTOCOL_VERSION,
    ...(target ? { payload: target } : {}),
  };

  try {
    const response: unknown = await chrome.runtime.sendMessage(message);
    if (isOpenDashboardResponse(response)) return response;
    return { ok: false, error: 'ValRecall received an invalid dashboard response.' };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : 'ValRecall could not contact the dashboard opener.',
    };
  }
}
