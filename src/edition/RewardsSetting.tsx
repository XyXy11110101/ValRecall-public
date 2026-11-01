import { useState } from 'react';

import { saveRewardsEnabled, useRewardsVisible } from './rewards';

export function RewardsSetting() {
  const enabled = useRewardsVisible();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function change(next: boolean) {
    setSaving(true);
    setFailed(false);
    try {
      await saveRewardsEnabled(next);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card stack">
      <h3>奖励</h3>
      <label className="cluster">
        <input
          style={{ width: 'auto' }}
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(event) => void change(event.target.checked)}
        />
        <span>显示零花钱奖励</span>
      </label>
      {enabled && <p className="muted small">这只是给自己的奖励记录，不是真钱。</p>}
      {failed && (
        <p className="muted small" role="alert">
          没能保存，请再试一次。
        </p>
      )}
    </div>
  );
}
