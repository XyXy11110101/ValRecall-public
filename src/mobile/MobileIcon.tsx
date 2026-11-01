export function MobileIcon({
  name,
}: {
  name:
    | 'tasks'
    | 'wallet'
    | 'settings'
    | 'back'
    | 'plus'
    | 'chevron'
    | 'sync'
    | 'check'
    | 'history'
    | 'help';
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === 'tasks' && (
        <>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="m8 12 3 3 5-6" />
        </>
      )}
      {name === 'wallet' && (
        <>
          <path d="M20 8V5H6a3 3 0 0 0 0 6h14v9H6a3 3 0 0 1-3-3V8" />
          <path d="M20 11h-5v5h5M17 13.5h.01" />
        </>
      )}
      {name === 'settings' && (
        <>
          <path d="M4 7h16M4 17h16" />
          <circle cx="9" cy="7" r="3" fill="currentColor" stroke="none" />
          <circle cx="15" cy="17" r="3" fill="currentColor" stroke="none" />
        </>
      )}
      {name === 'back' && <path d="m15 5-7 7 7 7" />}
      {name === 'plus' && <path d="M12 5v14M5 12h14" />}
      {name === 'chevron' && <path d="m9 5 7 7-7 7" />}
      {name === 'sync' && (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M5.4 8a7 7 0 0 1 11.5-3L20 8M4 16l3.1 3A7 7 0 0 0 18.6 16" />
        </>
      )}
      {name === 'check' && <path d="m5 12 4 4L19 6" />}
      {name === 'history' && (
        <>
          <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
          <path d="M12 7v5l3 2" />
        </>
      )}
      {name === 'help' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 17h.01" />
        </>
      )}
    </svg>
  );
}
