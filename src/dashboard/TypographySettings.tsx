import { useState, useSyncExternalStore } from 'react';

import { Notice } from '../shared/components';
import {
  FONT_CHOICES,
  TEXT_SIZES,
  VISIBLE_FONT_CHOICES,
  typography,
  type Typography,
  type TypographyStore,
} from '../ui/typography';
import './typography-settings.css';

const FONT_SAMPLE = '今天复习 19 道';

/** The font and text size. Applied at once, so it has no save button and no success notice. */
export function TypographySettings({ store = typography }: { store?: TypographyStore }) {
  const current = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [failed, setFailed] = useState(false);

  function choose(change: Partial<Typography>) {
    setFailed(false);
    void store.choose(change).then((saved) => setFailed(!saved));
  }

  return (
    <div className="card stack typography-settings">
      {failed && <Notice tone="error">字体和大小没保存，请重试。</Notice>}
      <fieldset>
        <legend>字体</legend>
        <div className="typography-fonts">
          {(__VALRECALL_PUBLIC_RELEASE__ ? VISIBLE_FONT_CHOICES : FONT_CHOICES).map(
            ({ id, label }) => (
              <label className="typography-option" key={id}>
                <input
                  type="radio"
                  name="typography-font"
                  value={id}
                  checked={current.font === id}
                  onChange={() => choose({ font: id })}
                />
                <span className="typography-font-name">{label}</span>
                <span className="typography-font-sample" data-font-sample={id} aria-hidden="true">
                  {FONT_SAMPLE}
                </span>
              </label>
            ),
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>大小</legend>
        <div className="typography-sizes">
          {TEXT_SIZES.map(({ id, label }) => (
            <label className="typography-option" key={id}>
              <input
                type="radio"
                name="typography-size"
                value={id}
                checked={current.size === id}
                onChange={() => choose({ size: id })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
