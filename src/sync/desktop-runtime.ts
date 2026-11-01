import type { DesktopSyncPort } from './service';
import { DesktopSyncService } from './service';
import { isRecord, probeResponse } from './protocol';

/** Wake open dashboards after any push, including a partially committed, lost-response batch. */
export function desktopSyncDependencies(port: DesktopSyncPort, notify: () => void) {
  const service = new DesktopSyncService(port);
  return {
    getEpoch: () => port.getEpoch(),
    onSync: async ({ deviceId, request }: { deviceId: string; request: unknown }) => {
      if (isRecord(request) && request.version === 1 && request.type === 'probe')
        return probeResponse(request);
      try {
        return await service.handle(deviceId, request);
      } finally {
        if (isRecord(request) && request.version === 2 && request.type === 'push') notify();
      }
    },
  };
}
