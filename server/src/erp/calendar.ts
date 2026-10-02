/** The demo company works in Central time; business dates must match the field UI. */
export function businessDate(offset = 0): string {
  const value = new Date(Date.now() + offset * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
