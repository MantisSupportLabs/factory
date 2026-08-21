/**
 * Jobsites panel (left sidebar): scannable list of the tenant's jobsites
 * from the live store, plus a collapsible "+ New jobsite" form. Tapping a
 * row selects the jobsite (opens JobsiteDetail in the right sidebar).
 */

import { useState } from 'react';
import { api } from '../api/client';
import type { Jobsite } from '../api/types';
import { useApp } from '../state/store';

function statusPillClass(status: string): string {
  switch (status) {
    case 'active':
      return 'pill pill-green';
    case 'planned':
      return 'pill pill-blue';
    case 'paused':
    case 'on_hold':
      return 'pill pill-amber';
    default:
      return 'pill';
  }
}

const emptyForm = () => ({
  name: '',
  code: '',
  lat: '',
  lng: '',
  address: '',
  superintendent: '',
});

export default function JobsitesPanel() {
  const jobsites = useApp((s) => s.jobsites);
  const selectedId = useApp((s) => s.selectedJobsiteId);
  const pollError = useApp((s) => s.pollError);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof ReturnType<typeof emptyForm>, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    const lat = Number(form.lat);
    const lng = Number(form.lng);
    if (
      !form.name.trim() ||
      !form.code.trim() ||
      form.lat.trim() === '' ||
      form.lng.trim() === '' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      setError('Name, code, lat and lng are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post<Jobsite>('/jobsites', {
        name: form.name.trim(),
        code: form.code.trim(),
        lat,
        lng,
        address: form.address.trim() || undefined,
        superintendent: form.superintendent.trim() || undefined,
      });
      setForm(emptyForm());
      setFormOpen(false);
      await useApp.getState().refresh();
      useApp.getState().bumpVersion();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {jobsites.length === 0 && (
        <p className="muted pad">{pollError ? `Error: ${pollError}` : 'No jobsites yet — add one below.'}</p>
      )}

      {jobsites.map((j) => (
        <button
          key={j.id}
          className={`list-row${j.id === selectedId ? ' selected' : ''}`}
          onClick={() => useApp.getState().selectJobsite(j.id)}
        >
          <span className="row-icon">📍</span>
          <div className="row-main">
            <div className="row-title">{j.name}</div>
            <div className="row-sub">
              {j.code}
              {j.superintendent ? ` · ${j.superintendent}` : ' · no super assigned'}
            </div>
          </div>
          <div className="row-end">
            <span className={statusPillClass(j.status)}>{j.status}</span>
          </div>
        </button>
      ))}

      <button className="btn wide" onClick={() => setFormOpen((o) => !o)}>
        {formOpen ? '− Cancel' : '+ New jobsite'}
      </button>

      {formOpen && (
        <div className="card">
          <h3>New jobsite</h3>
          <label className="field">Name</label>
          <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Hwy 12 Widening" />
          <label className="field">Code</label>
          <input type="text" value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="HW12" />
          <label className="field">Latitude</label>
          <input type="text" inputMode="decimal" value={form.lat} onChange={(e) => set('lat', e.target.value)} placeholder="39.7392" />
          <label className="field">Longitude</label>
          <input type="text" inputMode="decimal" value={form.lng} onChange={(e) => set('lng', e.target.value)} placeholder="-104.9903" />
          <label className="field">Address (optional)</label>
          <input type="text" value={form.address} onChange={(e) => set('address', e.target.value)} />
          <label className="field">Superintendent (optional)</label>
          <input type="text" value={form.superintendent} onChange={(e) => set('superintendent', e.target.value)} />
          {error && <p className="muted" style={{ color: 'var(--red)' }}>{error}</p>}
          <button className="btn primary wide" disabled={saving} onClick={submit}>
            {saving ? 'Creating…' : 'Create jobsite'}
          </button>
        </div>
      )}
    </div>
  );
}
