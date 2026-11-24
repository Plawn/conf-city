/** `text` with the first case-insensitive match of `search` marked. */
export function HighlightText({ text, search }: { text: string; search: string }) {
  if (!search) {
    return <>{text}</>;
  }
  const idx = text.toLowerCase().indexOf(search.toLowerCase());
  if (idx === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-warn/30 px-px text-warn">
        {text.slice(idx, idx + search.length)}
      </mark>
      {text.slice(idx + search.length)}
    </>
  );
}
