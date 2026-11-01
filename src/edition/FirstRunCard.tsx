import { openShortcutSettings, useCaptureShortcut } from './shortcut';
import './first-run-card.css';

/** Home for someone who has never saved anything. It goes once the first item is saved. */
export function FirstRunCard() {
  const shortcut = useCaptureShortcut();
  return (
    <section className="first-run-card" aria-labelledby="first-run-heading">
      <h3 id="first-run-heading">三步开始</h3>
      <ol className="first-run-steps">
        <li>
          <strong>打开视频</strong>
          <p>在 B 站、YouTube 或抖音打开一个视频。</p>
        </li>
        <li>
          <strong>按快捷键</strong>
          {shortcut === null ? (
            <>
              <p>还没有设置快捷键。设置好才能捕获。</p>
              <button className="button secondary" onClick={openShortcutSettings}>
                去设置快捷键
              </button>
            </>
          ) : shortcut ? (
            <p>
              看到想记住的地方，按 <kbd>{shortcut}</kbd>。
            </p>
          ) : (
            <p>看到想记住的地方，按捕获快捷键。</p>
          )}
        </li>
        <li>
          <strong>写问题</strong>
          <p>写一个问题。到时间再来回答。</p>
        </li>
      </ol>
    </section>
  );
}
