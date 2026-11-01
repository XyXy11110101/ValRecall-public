import { useEffect, useState } from 'react';

import { repository } from './services';

export function ItemThumbnail({
  screenshotId,
  alt,
  className = 'thumbnail',
  missingLabel = 'no screenshot available',
  hideWhenMissing = false,
  showMissingLabel = false,
}: {
  screenshotId: string | null;
  alt: string;
  className?: string;
  missingLabel?: string;
  hideWhenMissing?: boolean;
  showMissingLabel?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    async function load() {
      if (!screenshotId) return;
      try {
        const blob = await repository.getScreenshot(screenshotId);
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (active) setUrl(null);
      }
    }
    setUrl(null);
    setLoaded(false);
    void load();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [screenshotId]);

  if (!url) {
    if (hideWhenMissing) return null;
    return (
      <div className={className} role="img" aria-label={`${alt}; ${missingLabel}`}>
        {showMissingLabel && <span>{missingLabel}</span>}
      </div>
    );
  }
  return (
    <img
      className={`${className} motion-thumbnail`}
      data-loaded={loaded}
      src={url}
      alt={alt}
      onLoad={() => setLoaded(true)}
      onError={() => setUrl(null)}
    />
  );
}
