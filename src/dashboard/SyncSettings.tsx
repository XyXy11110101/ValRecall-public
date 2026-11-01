import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';

import { Notice } from '../shared/components';
import { worriedCompanionLeading } from './Companion';
import { NativeConnectionDiagnostics } from './NativeConnectionDiagnostics';
import {
  sendSyncControl,
  requestNativeSyncPermission,
  type SyncControlCommand,
  type SyncControlResponse,
  type SyncControlState,
} from '../sync/native-bridge';

export interface SyncSettingsProps {
  driver?: (command: SyncControlCommand) => Promise<SyncControlResponse>;
  confirmAction?: (message: string) => boolean;
  requestPermission?: () => Promise<boolean>;
}

const confirmSyncAction = (message: string) => window.confirm(message);

/** Pairing credentials stay in this mounted view and are never logged or stored. */
export function SyncSettings({
  driver = sendSyncControl,
  confirmAction = confirmSyncAction,
  requestPermission = requestNativeSyncPermission,
}: SyncSettingsProps) {
  const [state, setState] = useState<SyncControlState>({
    enabled: false,
    connected: false,
    status: null,
  });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [showPairText, setShowPairText] = useState(false);
  const [now, setNow] = useState(Date.now);
  const pending = useRef(false);
  const active = useRef(true);
  const requestVersion = useRef(0);
  const pairing = state.status?.pairing;
  const expiresAt = pairing ? Date.parse(pairing.expiresAt) : 0;
  const expired = expiresAt <= now;
  const selectedAddress = state.status?.addresses.includes(address)
    ? address
    : (pairing?.host ?? state.status?.addresses[0] ?? '');

  useEffect(() => {
    active.current = true;
    const request = ++requestVersion.current;
    setLoaded(false);
    void driver('status')
      .then((response) => {
        if (!active.current || request !== requestVersion.current) return;
        setState(response.state);
        setNotice(response.ok ? null : response.error);
        setLoaded(true);
      })
      .catch(() => {
        if (!active.current || request !== requestVersion.current) return;
        setNotice('读不到同步状态，请确认已安装 Windows 同步助手。');
        setLoaded(true);
      });
    return () => {
      active.current = false;
      requestVersion.current += 1;
    };
  }, [driver]);

  useEffect(() => {
    setNow(Date.now());
    if (!pairing) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0 || delay > 15 * 60_000) return;
    const timer = setTimeout(() => setNow(Date.now()), delay + 1);
    return () => clearTimeout(timer);
  }, [pairing, expiresAt]);

  const qr = useMemo(() => {
    if (!pairing || expired || !selectedAddress) return null;
    try {
      const code = qrcode(0, 'M');
      code.addData(JSON.stringify({ ...pairing, host: selectedAddress }), 'Byte');
      code.make();
      const count = code.getModuleCount();
      let path = '';
      for (let row = 0; row < count; row += 1) {
        for (let column = 0; column < count; column += 1) {
          if (code.isDark(row, column)) path += `M${column + 4} ${row + 4}h1v1h-1z`;
        }
      }
      return { path, size: count + 8 };
    } catch {
      return null;
    }
  }, [pairing, expired, selectedAddress]);

  async function control(command: SyncControlCommand) {
    if (pending.current) return;
    if (command === 'revoke' && !confirmAction('解除配对？解除前请先在手机上完成同步。')) return;
    pending.current = true;
    setBusy(true);
    setShowPairText(false);
    setNotice(null);
    const request = ++requestVersion.current;
    try {
      if (command === 'enable' && !(await requestPermission())) {
        if (active.current && request === requestVersion.current)
          setNotice('没有授权，手机同步未开启。');
        return;
      }
      const response = await driver(command);
      if (!active.current || request !== requestVersion.current) return;
      setState(response.state);
      setLoaded(true);
      setNow(Date.now());
      if (!response.ok) setNotice(response.error);
    } catch {
      if (active.current && request === requestVersion.current)
        setNotice('同步设置未能完成。请刷新状态后重试。');
    } finally {
      pending.current = false;
      if (active.current && request === requestVersion.current) setBusy(false);
    }
  }

  return (
    <section
      className="card stack sync-settings"
      aria-labelledby="sync-settings-heading"
      aria-busy={busy || !loaded}
    >
      <div>
        <h3 id="sync-settings-heading">Android 手机同步</h3>
        <p role="status">
          {!loaded
            ? '正在读取…'
            : !state.enabled
              ? '未启用'
              : !state.connected
                ? '等待同步助手连接'
                : state.status?.paired
                  ? '已配对手机'
                  : '已连接，未配对手机'}
        </p>
      </div>
      {notice && (
        <Notice tone="error" leading={worriedCompanionLeading()}>
          {notice}
        </Notice>
      )}
      {state.diagnostics && <NativeConnectionDiagnostics report={state.diagnostics} />}
      <div className="cluster">
        <button
          type="button"
          className="button secondary"
          disabled={!loaded || busy}
          onClick={() => void control(state.enabled ? 'disable' : 'enable')}
        >
          {state.enabled ? '关闭手机同步' : '启用手机同步'}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !loaded}
          onClick={() => void control('status')}
        >
          刷新同步状态
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !loaded}
          onClick={() => void control('diagnose')}
        >
          检查连接
        </button>
        <button
          type="button"
          className="button"
          disabled={
            !loaded ||
            busy ||
            !state.enabled ||
            !state.connected ||
            state.status?.paired ||
            !state.status?.addresses.length
          }
          onClick={() => void control('pair')}
        >
          生成配对二维码
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || !state.connected || !state.status?.paired}
          onClick={() => void control('revoke')}
        >
          解除手机配对
        </button>
      </div>
      {state.connected && state.status?.addresses.length === 0 && (
        <Notice tone="warning">
          没有找到局域网地址。请让电脑连接与手机相同的可信 Wi-Fi，然后刷新状态。
        </Notice>
      )}
      {state.connected && pairing && (
        <div className="stack">
          {expired ? (
            <Notice tone="warning">配对二维码已过期，请重新生成。</Notice>
          ) : (
            <>
              <label className="field">
                <span>电脑局域网地址</span>
                <select
                  value={selectedAddress}
                  disabled={busy}
                  onChange={(event) => setAddress(event.target.value)}
                >
                  {state.status?.addresses.map((host) => (
                    <option key={host} value={host}>
                      {host}
                    </option>
                  ))}
                </select>
                <span className="muted small">有多个地址时，选择与手机 Wi-Fi 同一网段的地址。</span>
              </label>
              {qr ? (
                <svg
                  role="img"
                  aria-label="手机配对二维码"
                  viewBox={`0 0 ${qr.size} ${qr.size}`}
                  width="280"
                  height="280"
                  style={{ maxWidth: '100%', height: 'auto', background: '#fff' }}
                  shapeRendering="crispEdges"
                >
                  <title>用 ValRecall Android 扫描以配对</title>
                  <rect width={qr.size} height={qr.size} fill="#fff" />
                  <path d={qr.path} fill="#000" />
                </svg>
              ) : (
                <Notice tone="error">配对二维码无法生成，请重新生成后重试。</Notice>
              )}
              <p className="small">
                在 ValRecall Android 中扫描。有效期至 {new Date(expiresAt).toLocaleTimeString()}
                ；请勿分享此二维码。
              </p>
              <p className="muted small">手机完成配对后，点击“刷新同步状态”查看结果。</p>
              <details onToggle={(event) => setShowPairText(event.currentTarget.open)}>
                <summary>无法扫描？查看一次性配对码</summary>
                {showPairText && (
                  <label className="field">
                    <span>仅粘贴到你自己的 ValRecall 手机 App，不要分享</span>
                    <textarea
                      readOnly
                      rows={5}
                      spellCheck={false}
                      aria-label="一次性配对码"
                      value={JSON.stringify({ ...pairing, host: selectedAddress })}
                    />
                  </label>
                )}
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}
