export function ActionIcon({ kind }: { kind: 'play' | 'plus' }) {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {kind === 'play' ? (
        <path d="M8 5.5 19 12 8 18.5Z" fill="currentColor" />
      ) : (
        <path
          d="M12 5v14M5 12h14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
