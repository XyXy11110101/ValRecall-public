import { useEffect, useState } from 'react';

import { lastBackupLine, loadLastBackup, onLastBackupChanged } from './data-safety';

// Checked in Edge on a clean profile: with the fixed key the ID and the data survive a folder move,
// and removing the extension deletes the data. Deleting on this page keeps some records: see deleteAllCopy.
const CHECK_SAVED_LINE = '导出后，请确认文件已经存好。';
const DATA_SAFETY_LINE =
  '卸载扩展会删除这里的全部数据，卸载前请先导出。移动扩展文件夹不会丢数据：在新位置重新加载就行，不要先卸载。';

export function DataSafetyNote() {
  // Undefined: not known, or the read failed. Saying "no backup" then might not be true.
  const [lastBackup, setLastBackup] = useState<Date | null | undefined>(undefined);
  useEffect(() => {
    void loadLastBackup()
      .then((date) => setLastBackup((current) => (current === undefined ? date : current)))
      .catch(() => undefined);
    return onLastBackupChanged(setLastBackup);
  }, []);
  return (
    <>
      <p className="muted">下载一份备份。</p>
      {lastBackup !== undefined && <p className="muted">{lastBackupLine(lastBackup)}</p>}
      <p className="muted">{CHECK_SAVED_LINE}</p>
      <p className="muted">{DATA_SAFETY_LINE}</p>
    </>
  );
}
