import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { startTypography } from '../ui/typography';
import { DashboardApp } from './DashboardApp';
import { requestPersistentStorageOnce } from '../edition/data-safety';
import '../styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('ValRecall dashboard root was not found.');

if (__VALRECALL_PUBLIC_RELEASE__) void requestPersistentStorageOnce();
if (__VALRECALL_PUBLIC_RELEASE__) void import('../edition/rewards-boot');

void startTypography().then(() => {
  createRoot(root).render(
    <StrictMode>
      <DashboardApp />
    </StrictMode>,
  );
});
