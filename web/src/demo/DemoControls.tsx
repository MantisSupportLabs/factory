import { useRef, useState } from 'react';
import { browserDemo, demoEngine } from './client';
export function DemoControls() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  if (!browserDemo) return null;
  const exportData = async () => {
    setBusy(true); setError('');
    try {
      const data = await (await demoEngine()).exportDemo();
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'dirtworks-browser-demo.json';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!window.confirm('Reset this browser’s demo data and attachments to the sample workspace? Export first to keep a copy.')) return;
    setBusy(true); setError('');
    try { await (await demoEngine()).resetDemo(); window.location.reload(); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  };
  const restore = async (file?: File) => {
    if (!file) return;
    if (!window.confirm('Replace this browser’s workspace with the exported demo? Export the current data first if you need to keep it.')) return;
    setBusy(true); setError('');
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('Demo imports must be smaller than 64 MB.');
      await (await demoEngine()).importDemo(await file.text()); window.location.reload();
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
    finally { if (input.current) input.current.value = ''; }
  };
  return <aside className="browser-demo-banner" aria-label="Browser demo">
    <div><strong>Browser demo</strong> · Changes save on this device. Sample data and open access; no device sync.</div>
    <div><button type="button" disabled={busy} onClick={() => { void exportData(); }}>Export demo</button>
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>Import demo</button>
      <input ref={input} hidden type="file" accept="application/json,.json" aria-label="Import demo export" onChange={event => { void restore(event.target.files?.[0]); }} />
      <button type="button" disabled={busy} onClick={() => { void reset(); }}>Reset sample data</button></div>
    {error && <div role="alert">{error}</div>}
  </aside>;
}
