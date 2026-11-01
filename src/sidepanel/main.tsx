import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { CompanionWardrobeProvider } from '../companion/CompanionWardrobe';
import { reloadWhenDataDeleted } from '../edition/pending-capture-clear';
import { startTypography } from '../ui/typography';
import { SidePanelApp } from './SidePanelApp';
import '../styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('ValRecall side panel root was not found.');

if (__VALRECALL_PUBLIC_RELEASE__) void import('../edition/rewards-boot');
if (__VALRECALL_PUBLIC_RELEASE__ && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  reloadWhenDataDeleted(chrome);
}

void startTypography().then(() => {
  createRoot(root).render(
    <StrictMode>
      <CompanionWardrobeProvider>
        <SidePanelApp />
      </CompanionWardrobeProvider>
    </StrictMode>,
  );
});
