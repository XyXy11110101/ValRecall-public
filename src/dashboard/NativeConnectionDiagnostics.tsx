import {
  DIAGNOSTIC_STAGES,
  type DiagnosticStage,
  type NativeDiagnosticReport,
} from '../sync/native-diagnostics';

const labels: Record<DiagnosticStage, string> = {
  permission: '扩展权限',
  discovery: '助手发现',
  launch: '程序启动',
  handshake: '协议握手',
  lan: '局域网监听',
  phone: '手机连接',
};
const outcomes = { passed: '已验证', failed: '未通过', unknown: '未验证' } as const;

/** This allowlisted text contains no host address, device ID, QR, token or task data. */
export function nativeDiagnosticText(report: NativeDiagnosticReport): string {
  return [
    'ValRecall 连接检查 v1',
    `检查时间：${report.checkedAt}`,
    ...DIAGNOSTIC_STAGES.map((stage) => `${labels[stage]}：${outcomes[report.checks[stage]]}`),
    `错误分类：${report.errorCode ?? '无'}`,
    `最近手机请求：${report.phoneSeenAt ?? '无'}`,
  ].join('\n');
}

export function NativeConnectionDiagnostics({ report }: { report: NativeDiagnosticReport }) {
  return (
    <div className="stack small" aria-label="连接检查结果">
      <p className="muted">检查于 {new Date(report.checkedAt).toLocaleString()}</p>
      <ul>
        {DIAGNOSTIC_STAGES.map((stage) => (
          <li key={stage}>
            {labels[stage]}：{outcomes[report.checks[stage]]}
          </li>
        ))}
      </ul>
      <details>
        <summary>查看检查报告</summary>
        <label className="field">
          <span>只需分享此报告，不要分享二维码</span>
          <textarea
            id="valrecall-native-diagnostic-report"
            name="native-diagnostic-report"
            aria-label="可复制的连接检查报告"
            readOnly
            rows={11}
            value={nativeDiagnosticText(report)}
          />
        </label>
      </details>
    </div>
  );
}
