import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, setCsrfToken, setTenant } from '../api/client';
import { Badge, Empty, Field, SectionHead } from './ui';
import { OfflineCenter } from './Documents';
import { emptyERP } from './types';
import { browserDemo } from '../demo/client';

type Role = 'owner' | 'admin' | 'pm' | 'foreman' | 'dispatcher' | 'mechanic' | 'accountant';
interface User { id: number; tenant_id: number; name: string; email: string; role: Role; }
interface Session { mode: 'demo' | 'secure'; user: User | null; csrf_token?: string; setup_required?: boolean; setup_requires_token?: boolean; }
interface AccessContextValue extends Session { role: Role | null; refresh: () => Promise<void>; logout: () => Promise<void>; }
const AccessContext = createContext<AccessContextValue | null>(null);
const roles: Role[] = ['owner', 'admin', 'pm', 'foreman', 'dispatcher', 'mechanic', 'accountant'];
const roleLabel = (role: Role) => ({ owner: 'Owner', admin: 'Administrator', pm: 'Project manager', foreman: 'Field foreman', dispatcher: 'Dispatcher', mechanic: 'Mechanic', accountant: 'Accountant' })[role];
const message = (failure: unknown) => failure instanceof Error ? failure.message : 'Unable to complete this request';

export function useAccess(): AccessContextValue {
  const context = useContext(AccessContext);
  if (!context) throw new Error('useAccess must be used inside AccessBoundary');
  return context;
}
export function AccessBoundary({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [offlineStartup, setOfflineStartup] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const result = await api.get<Session>('/auth/session');
      setCsrfToken(result.csrf_token ?? null);
      if (result.user) setTenant(String(result.user.tenant_id));
      setSession(result); setError(''); setOfflineStartup(false);
    } catch (failure) { setOfflineStartup(failure instanceof TypeError); setError(message(failure)); throw failure; }
  }, []);
  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setCsrfToken(null); await refresh();
  }, [refresh]);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  if (!session) return <div className="erp-access-screen"><div className="erp-card erp-stack"><h1>DirtWorks</h1>{error ? <><div className="erp-alert" role="alert">{error}</div><button className="erp-button" onClick={() => { void refresh().catch(() => undefined); }}>Retry connection</button>{offlineStartup && <OfflineCenter data={emptyERP} refresh={async () => undefined} />}</> : <Empty>Checking company access…</Empty>}</div></div>;
  const value = { ...session, role: session.user?.role ?? null, refresh, logout };
  return <AccessContext.Provider value={value}>{session.mode === 'secure' && !session.user
    ? <div className="erp-access-screen"><div className="erp-card erp-stack">{session.setup_required ? <SetupForm requiresToken={Boolean(session.setup_requires_token)} /> : <LoginForm />}</div></div>
    : children}</AccessContext.Provider>;
}
function LoginForm() {
  const access = useAccess();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api.post<Session>('/auth/login', { email, password });
      setCsrfToken(result.csrf_token ?? null); if (result.user) setTenant(String(result.user.tenant_id));
      setPassword(''); await access.refresh();
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  return <><div><p className="erp-eyebrow">Company workspace</p><h1>Sign in to DirtWorks</h1><p>Projects, crews, and field operations in one place.</p></div><form className="erp-stack" onSubmit={submit}>{error && <div className="erp-alert" role="alert">{error}</div>}<Field label="Email"><input autoComplete="username" type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></Field><Field label="Password"><input autoComplete="current-password" type="password" required maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></Field><button className="erp-button primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form></>;
}
function SetupForm({ requiresToken }: { requiresToken: boolean }) {
  const access = useAccess();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', setup_token: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (form.password !== form.confirm) { setError('Passwords must match'); return; }
    setBusy(true);
    try {
      const { confirm: _confirm, ...payload } = form;
      const result = await api.post<Session>('/auth/setup', payload);
      setCsrfToken(result.csrf_token ?? null); if (result.user) setTenant(String(result.user.tenant_id));
      setForm({ name: '', email: '', password: '', confirm: '', setup_token: '' }); await access.refresh();
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  return <><SectionHead title="Enable secure access" description="Create the first owner account, then invite your project managers and field team with the right access." /><p>Enabling access requires everyone to sign in. The existing company records stay available to your team.</p><form className="erp-stack" onSubmit={submit}>{error && <div className="erp-alert" role="alert">{error}</div>}<div className="erp-form-grid"><Field label="Owner name"><input required autoComplete="name" maxLength={150} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field><Field label="Owner email"><input required autoComplete="username" type="email" maxLength={254} value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></Field><Field label="Password · at least 12 characters"><input required autoComplete="new-password" type="password" minLength={12} maxLength={128} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></Field><Field label="Confirm password"><input required autoComplete="new-password" type="password" minLength={12} maxLength={128} value={form.confirm} onChange={event => setForm({ ...form, confirm: event.target.value })} /></Field>{requiresToken && <Field label="Server setup token" wide><input required autoComplete="off" type="password" maxLength={1024} value={form.setup_token} onChange={event => setForm({ ...form, setup_token: event.target.value })} /><small>Provided by the administrator who configured this server.</small></Field>}</div><div className="erp-form-actions"><button className="erp-button primary" disabled={busy}>{busy ? 'Enabling access…' : 'Create owner and enable sign-in'}</button></div></form></>;
}
interface ManagedUser extends User { active: number; created_at: string; }
interface Audit { id: number; actor_name: string; actor_id: number | null; method: string; path: string; record_id: string | null; created_at: string; status: number; }
export function AccessSettings() {
  const access = useAccess();
  const [users, setUsers] = useState<ManagedUser[]>([]), [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'foreman' as Role, password: '' });
  const isAdmin = access.role === 'owner' || access.role === 'admin';
  const reload = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true); setError('');
    try {
      const [accounts, entries] = await Promise.all([api.get<ManagedUser[]>('/auth/users'), api.get<Audit[]>('/erp/audit?limit=100')]);
      setUsers(accounts); setAudit(entries);
    } catch (failure) { setError(message(failure)); } finally { setLoading(false); }
  }, [isAdmin]);
  useEffect(() => { void reload(); }, [reload]);
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.post('/auth/users', form); setForm({ name: '', email: '', role: 'foreman', password: '' }); await reload(); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const update = async (user: ManagedUser, changes: Record<string, unknown>) => {
    await api.patch(`/auth/users/${user.id}`, changes);
    if (user.id === access.user?.id) await access.refresh();
    await reload();
  };
  if (browserDemo) return <div className="erp-card erp-stack"><Badge tone="warning">Browser demo access</Badge><p>All demo features open without sign-in. Changes and attachments save only in this browser. Accounts, role enforcement, audit attribution, and live provider connections require the hosted backend.</p><p>Use the demo banner to export your test data or reset the sample workspace.</p></div>;
  if (access.mode === 'demo') return <div className="erp-stack"><div className="erp-card"><Badge tone="warning">Demo access</Badge><p>This workspace currently opens without sign-in. Create an owner account to enable company access controls.</p></div><div className="erp-card erp-stack"><SetupForm requiresToken={Boolean(access.setup_requires_token)} /></div></div>;
  return <div className="erp-stack"><SectionHead title="Company access" description="Manage accounts and review the record of successful changes." action={<button className="erp-button" onClick={() => { void access.logout().catch(failure => setError(message(failure))); }}>Sign out</button>} /><div className="erp-card"><strong>{access.user?.name}</strong> · {access.user?.email} <Badge tone="success">{access.role ? roleLabel(access.role) : 'Signed in'}</Badge><p>Your account belongs to this company. Company access is checked on every request.</p></div>{error && <div className="erp-alert" role="alert">{error}</div>}{!isAdmin ? <Empty>An owner or administrator manages company accounts and audit history.</Empty> : <><div className="erp-card erp-stack"><SectionHead title="Add team member" description="Create an individual account and share its initial password directly with that person." /><form className="erp-stack" onSubmit={create}><div className="erp-form-grid"><Field label="Name"><input required maxLength={150} autoComplete="off" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field><Field label="Email"><input required type="email" maxLength={254} autoComplete="off" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></Field><Field label="Role"><select value={form.role} onChange={event => setForm({ ...form, role: event.target.value as Role })}>{roles.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></Field><Field label="Initial password · at least 12 characters"><input required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></Field></div><div className="erp-form-actions"><button className="erp-button primary" disabled={busy}>{busy ? 'Creating account…' : 'Add account'}</button></div></form></div><div className="erp-card"><SectionHead title="Team accounts" action={<button className="erp-button" disabled={loading} onClick={() => { void reload(); }}>Refresh</button>} />{loading ? <Empty>Loading accounts…</Empty> : <div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>Account</th><th>Access role</th><th>Status</th><th>Actions</th></tr></thead><tbody>{users.map(user => <AccountRow key={user.id} user={user} self={user.id === access.user?.id} update={update} />)}</tbody></table></div>}</div><div className="erp-card"><SectionHead title="Audit history" description="Latest 100 successful changes, attributed to the signed-in account. Audit records cannot be edited or deleted." />{!audit.length ? <Empty>No changes recorded yet.</Empty> : <div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>When</th><th>Actor</th><th>Operation</th><th>Record</th></tr></thead><tbody>{audit.map(entry => <tr key={entry.id}><td>{new Date(entry.created_at).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' })}</td><td>{entry.actor_name}{entry.actor_id === null && <><br /><small>Demo access</small></>}</td><td><Badge>{entry.method}</Badge> {entry.path}</td><td>{entry.record_id ?? '—'}</td></tr>)}</tbody></table></div>}</div></>}</div>;
}
function AccountRow({ user, self, update }: { user: ManagedUser; self: boolean; update: (user: ManagedUser, changes: Record<string, unknown>) => Promise<void> }) {
  const [role, setRole] = useState(user.role), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [resetOpen, setResetOpen] = useState(false), [password, setPassword] = useState('');
  useEffect(() => setRole(user.role), [user.role]);
  const save = async (changes: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await update(user, changes); setPassword(''); setResetOpen(false); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  return <tr><td><strong>{user.name}{self ? ' (you)' : ''}</strong><br /><small>{user.email}</small>{error && <div role="alert" className="erp-alert">{error}</div>}</td><td><select aria-label={`Access role for ${user.name}`} value={role} disabled={busy} onChange={event => setRole(event.target.value as Role)}>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select>{role !== user.role && <button type="button" className="erp-button" disabled={busy} onClick={() => { void save({ role }); }}>Save role</button>}</td><td><Badge tone={user.active ? 'success' : 'neutral'}>{user.active ? 'Active' : 'Disabled'}</Badge></td><td><div className="erp-stack"><button type="button" className="erp-button" disabled={busy || (self && Boolean(user.active))} onClick={() => { void save({ active: !user.active }); }}>{user.active ? 'Disable account' : 'Activate account'}</button><button type="button" className="erp-button" disabled={busy} onClick={() => setResetOpen(!resetOpen)}>Reset password</button>{resetOpen && <form className="erp-stack" onSubmit={event => { event.preventDefault(); void save({ password }); }}><Field label="New password"><input type="password" required autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></Field><small>This signs the account out of all devices.</small><button className="erp-button" disabled={busy}>Save password</button></form>}</div></td></tr>;
}
