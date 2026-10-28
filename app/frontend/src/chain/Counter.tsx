/** One icon + number of a box's counters row; the icon says what is counted, the tooltip says it in words. */
export default function Counter({ icon, value, title }: { icon: string; value: number | string; title: string }) {
  return (
    <span title={title} data-counter={icon}>
      {icon} {value}
    </span>
  );
}
