import { clearWorkingCard } from '../shared/working-card-store';
import { lazy, Suspense, useState } from 'react';

import { Notice } from '../shared/components';
import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../models/messages';
import { displayError, downloadJson, hasExtensionRuntime } from '../shared/extension';
import { repository } from './services';
import { useOperation } from '../shared/use-operation';
import { useEditProtection } from '../shared/edit-protection';
import { LegacyNotesArchive } from '../intake/LegacyNotesArchive';
import type { ImportMode } from '../database';
import { backupFileDate, deleteAllCopy, recordLastBackup } from '../edition/data-safety';
import { useRewardsVisible } from '../edition/rewards';

const WORKING_CARD_NOT_CLEARED = '工作中卡片的内容没清除，请再试一次。';

/** The card's next-step notes live outside the database, so its clear does not reach them. */
function clearedWorkingCard(): Promise<boolean> {
  return clearWorkingCard().then(
    () => true,
    () => false,
  );
}

/** The backup date and uninstall warning ship in the public edition only, as their own chunk. */
const DataSafetyNote = __VALRECALL_PUBLIC_RELEASE__
  ? lazy(() =>
      import('../edition/DataSafetyNote').then((module) => ({ default: module.DataSafetyNote })),
    )
  : null;

export function DataView({
  onChanged,
  onBackToSettings,
}: {
  onChanged: () => void;
  onBackToSettings: () => void;
}) {
  const operation = useOperation();
  const { busy } = operation;
  const rewardsOn = __VALRECALL_PUBLIC_RELEASE__ ? useRewardsVisible() : true;
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [restoreWallet, setRestoreWallet] = useState(false);
  useEditProtection({ dirty: false, busy: () => operation.pending.current });
  const [notice, setNotice] = useState<{
    text: string;
    tone: 'success' | 'warning' | 'error';
  } | null>(null);

  async function exportData() {
    if (!operation.begin()) return;
    try {
      const data = await repository.exportData();
      const date = backupFileDate();
      downloadJson(data, `valrecall-backup-${date}.json`);
      if (__VALRECALL_PUBLIC_RELEASE__) await recordLastBackup();
      setNotice({ text: '已导出。', tone: 'success' });
    } catch (error) {
      setNotice({ text: displayError(error, '数据导出失败。'), tone: 'error' });
    } finally {
      operation.finish();
    }
  }

  async function importData(file: File) {
    if (operation.pending.current) return;
    if (
      !window.confirm(
        importMode === 'merge'
          ? '合并导入这份备份？相同 ID 的条目会被更新。'
          : __VALRECALL_PUBLIC_RELEASE__
            ? `用这份备份替换全部学习和待办数据？${restoreWallet ? '零花钱也会替换。' : ''}如果你在用手机版，请先在手机上完成同步。`
            : `用这份备份替换全部学习和待办数据？${restoreWallet ? '零花钱也会替换。' : ''}请先在手机上完成同步。`,
      )
    ) {
      return;
    }
    if (!operation.begin()) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const containsWallet =
        typeof parsed === 'object' &&
        parsed !== null &&
        'schemaVersion' in parsed &&
        typeof parsed.schemaVersion === 'number' &&
        parsed.schemaVersion >= 9;
      const result =
        importMode === 'merge'
          ? await repository.importData(parsed, 'merge')
          : await repository.importData(parsed, 'replace', {
              restoreWallet: restoreWallet && containsWallet,
            });
      const cardCleared = importMode === 'replace' ? await clearedWorkingCard() : true;
      setNotice({
        text: `已导入 ${result.items} 条回忆题、${result.tasks} 项待办等。${!containsWallet ? (rewardsOn ? '这份备份不含零花钱。' : '') : importMode === 'replace' && restoreWallet ? '零花钱已按备份恢复。' : ''}${cardCleared ? '' : WORKING_CARD_NOT_CLEARED}`,
        tone: (containsWallet || !rewardsOn) && cardCleared ? 'success' : 'warning',
      });
      onChanged();
      setArchiveRevision((value) => value + 1);
    } catch (error) {
      setNotice({
        text: displayError(error, '导入失败。请确认这是 ValRecall 备份。'),
        tone: 'error',
      });
    } finally {
      operation.finish();
    }
  }

  async function deleteAll() {
    if (operation.pending.current) return;
    if (
      !window.confirm(
        __VALRECALL_PUBLIC_RELEASE__
          ? deleteAllCopy(rewardsOn).confirm
          : '删除本机全部学习数据？零花钱会保留。没有备份将无法恢复。',
      )
    ) {
      return;
    }
    if (!operation.begin()) return;
    try {
      await repository.clearAllData();
      const cardCleared = await clearedWorkingCard();
      if (hasExtensionRuntime()) {
        await chrome.runtime
          .sendMessage({
            type: MESSAGE_TYPES.dismissCapture,
            version: MESSAGE_PROTOCOL_VERSION,
          })
          .catch(() => undefined);
      }
      setNotice({
        text: `${deleteAllCopy(rewardsOn).done}${cardCleared ? '' : WORKING_CARD_NOT_CLEARED}`,
        tone: cardCleared ? 'success' : 'warning',
      });
      onChanged();
      setArchiveRevision((value) => value + 1);
    } catch (error) {
      setNotice({ text: displayError(error, '本地数据无法删除。'), tone: 'error' });
    } finally {
      operation.finish();
    }
  }

  return (
    <section className="stack data-view" aria-busy={busy}>
      <div className="split data-view-header">
        <div>
          <p className="eyebrow">数据管理</p>
          <h2 className="dashboard-page-heading" tabIndex={-1}>
            备份与恢复
          </h2>
          <p className="muted">导出或恢复全部学习数据。</p>
        </div>
        <button
          className="button secondary small-button motion-press"
          disabled={busy}
          onClick={onBackToSettings}
        >
          返回设置
        </button>
      </div>
      {notice && (
        <div className="motion-state-change" key={notice.text}>
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
      {busy && (
        <div className="dashboard-operation-status" role="status">
          <span className="motion-loading-indicator" aria-hidden="true" />
          <span>正在更新本地数据…</span>
        </div>
      )}
      <div className="card stack">
        <div>
          <h3>导出</h3>
          {__VALRECALL_PUBLIC_RELEASE__ && DataSafetyNote ? (
            <Suspense fallback={null}>
              <DataSafetyNote />
            </Suspense>
          ) : (
            <p className="muted">下载一份备份。</p>
          )}
          <button className="button motion-press" disabled={busy} onClick={() => void exportData()}>
            导出全部数据
          </button>
        </div>
        <div>
          <h3>导入</h3>
          <p className="muted">只能导入之前由 ValRecall 导出的 JSON 文件。</p>
          <label className="field">
            <span>恢复方式</span>
            <select
              value={importMode}
              disabled={busy}
              onChange={(event) => {
                setImportMode(event.target.value === 'replace' ? 'replace' : 'merge');
                setRestoreWallet(false);
              }}
            >
              <option value="merge">合并</option>
              <option value="replace">替换学习和任务数据</option>
            </select>
          </label>
          {__VALRECALL_PUBLIC_RELEASE__ && !rewardsOn
            ? null
            : importMode === 'replace' && (
                <label className="cluster">
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={restoreWallet}
                    disabled={busy}
                    onChange={(event) => setRestoreWallet(event.target.checked)}
                  />
                  <span>同时恢复备份中的零花钱（替换当前余额及账本）</span>
                </label>
              )}
          <label
            className="button secondary motion-press"
            style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            选择备份文件
            <input
              className="sr-only"
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importData(file);
                event.target.value = '';
              }}
            />
          </label>
        </div>
      </div>
      <LegacyNotesArchive revision={archiveRevision} />
      <div className="card danger-zone">
        <h3>
          {__VALRECALL_PUBLIC_RELEASE__ ? deleteAllCopy(rewardsOn).title : '删除全部本地学习数据'}
        </h3>
        <p>
          {__VALRECALL_PUBLIC_RELEASE__
            ? deleteAllCopy(rewardsOn).panel
            : '永久删除回忆题、待办和复习记录。零花钱会保留。'}
        </p>
        <button
          className="button danger motion-press"
          disabled={busy}
          onClick={() => void deleteAll()}
        >
          {__VALRECALL_PUBLIC_RELEASE__ ? deleteAllCopy(rewardsOn).title : '删除全部学习数据'}
        </button>
      </div>
    </section>
  );
}
