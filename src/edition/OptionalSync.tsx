import { useState } from 'react';

import { SyncSettings } from '../dashboard/SyncSettings';

/** Closed by default. The settings mount on opening, so nothing asks for the helper before that. */
export function OptionalSync() {
  const [open, setOpen] = useState(false);
  return (
    <details className="card stack" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>手机同步（可选）</summary>
      <p className="muted">不用手机版，可以不管这里。电脑上的功能都能照常用。</p>
      <p className="muted">
        手机同步要用一个同步助手，这个助手要你自己构建。做法见源码仓库里的 docs/LOCAL_SYNC.md。
      </p>
      {open && <SyncSettings />}
    </details>
  );
}
