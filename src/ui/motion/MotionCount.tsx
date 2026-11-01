export function MotionCount({
  value,
  className = '',
  as = 'span',
}: {
  value: number;
  className?: string;
  as?: 'span' | 'strong';
}) {
  const Element = as;
  return (
    <Element className={`motion-count-change${className ? ` ${className}` : ''}`} key={value}>
      {value}
    </Element>
  );
}
