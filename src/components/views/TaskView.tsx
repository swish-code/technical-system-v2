import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { useFetch } from '../../hooks/useFetch';
import { Plus, Clock, Settings, Trash2, ListChecks, Activity, Gauge, CheckCircle2, XCircle, Loader2, ChevronDown, ClipboardList, Send } from 'lucide-react';

// Self-contained "Task" page — New Technical Log form + stats + logs + config.
// Talks only to /api/task-* endpoints; independent of the rest of the app.
const QUICK_MINS = [5, 10, 15, 30, 45, 60];

export default function TaskView() {
  const { user, lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const ar = lang === 'ar';
  const isAdmin = ['Manager', 'Super Visor', 'Operation Manager'].includes(user?.role_name || '');

  const [activities, setActivities] = useState<any[]>([]);
  const [statuses, setStatuses] = useState<any[]>([]);
  const [brands, setBrands] = useState<any[]>([]);

  // Form
  const [activityType, setActivityType] = useState('');
  const [status, setStatus] = useState('');
  const [minutes, setMinutes] = useState<number>(0);
  const [brandId, setBrandId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Data
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [logs, setLogs] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [tab, setTab] = useState<'new' | 'dash' | 'config'>('new');

  // Config editing
  const [newActivity, setNewActivity] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const [newStatusCounts, setNewStatusCounts] = useState(false);

  const fetchConfig = async () => {
    try { const r = await fetchWithAuth(`${API_URL}/task-config`); if (r.ok) { const d = await r.json(); setActivities(d.activities || []); setStatuses(d.statuses || []); } } catch { /* ignore */ }
  };
  const fetchBrands = async () => {
    try { const r = await fetchWithAuth(`${API_URL}/brands`); if (r.ok) setBrands(await r.json()); } catch { /* ignore */ }
  };
  const fetchLogs = async () => {
    try { const r = await fetchWithAuth(`${API_URL}/task-logs?date=${date}`); if (r.ok) setLogs(await r.json()); } catch { /* ignore */ }
  };
  const fetchSummary = async () => {
    try { const r = await fetchWithAuth(`${API_URL}/task-logs/summary?date=${date}`); if (r.ok) setSummary(await r.json()); } catch { /* ignore */ }
  };

  useEffect(() => { fetchConfig(); fetchBrands(); }, []);
  useEffect(() => { fetchLogs(); fetchSummary(); }, [date]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  const canSave = !!activityType && !!status && minutes > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const r = await fetchWithAuth(`${API_URL}/task-logs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_type: activityType, status, duration_seconds: minutes * 60, brand_id: brandId || null, notes: notes.trim() || null }),
      });
      if (r.ok) {
        setToast({ msg: ar ? 'تم حفظ المهمة بنجاح ✓' : 'Task log saved ✓', ok: true });
        setActivityType(''); setStatus(''); setMinutes(0); setBrandId(''); setNotes('');
        fetchLogs(); fetchSummary();
      } else {
        const e = await r.json().catch(() => ({}));
        setToast({ msg: e.error || (ar ? 'فشل الحفظ' : 'Save failed'), ok: false });
      }
    } catch { setToast({ msg: ar ? 'فشل الحفظ' : 'Save failed', ok: false }); }
    finally { setSaving(false); }
  };

  const fmtDur = (s: number) => { const m = Math.round((Number(s) || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
  const hours = (s: any) => ((Number(s) || 0) / 3600).toFixed(1);

  const addActivity = async () => { if (!newActivity.trim()) return; await fetchWithAuth(`${API_URL}/task-config/activity`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newActivity.trim() }) }); setNewActivity(''); fetchConfig(); };
  const delActivity = async (id: number) => { await fetchWithAuth(`${API_URL}/task-config/activity/${id}`, { method: 'DELETE' }); fetchConfig(); };
  const addStatus = async () => { if (!newStatus.trim()) return; await fetchWithAuth(`${API_URL}/task-config/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newStatus.trim(), counts_time: newStatusCounts }) }); setNewStatus(''); setNewStatusCounts(false); fetchConfig(); };
  const delStatus = async (id: number) => { await fetchWithAuth(`${API_URL}/task-config/status/${id}`, { method: 'DELETE' }); fetchConfig(); };

  const label = "block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2";
  const field = "w-full px-5 py-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800 text-[15px] font-bold outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white";
  const statusColor = (s: string) => s === 'Completed' || s === 'Solved' ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20' : s === 'In Progress' ? 'text-amber-600 bg-amber-50 dark:bg-amber-900/20' : 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800';

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {toast && (
        <div className={cn("fixed top-6 right-6 z-[200] px-5 py-3 rounded-2xl font-black text-sm shadow-2xl flex items-center gap-2",
          toast.ok ? "bg-emerald-600 text-white" : "bg-red-500 text-white")}>
          {toast.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}{toast.msg}
        </div>
      )}

      <div>
        <h1 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight flex items-center gap-2">
          <ListChecks className="text-brand" size={26} /> {ar ? 'المهام' : 'Task'}
        </h1>
        <p className="text-zinc-500 font-medium text-sm mt-0.5">{ar ? 'سجّل مهامك التقنية وتتبّع وقتك وإنتاجيتك' : 'Log technical tasks and track time & productivity'}</p>
      </div>

      {/* Sub-tabs — each section shows on its own; the form hides when you switch away */}
      <div className="flex gap-1 p-1 bg-zinc-100 dark:bg-zinc-800/60 rounded-2xl w-full sm:w-fit overflow-x-auto">
        <TabButton active={tab === 'new'} onClick={() => setTab('new')} icon={<Plus size={16} />}>{ar ? 'مهمة جديدة' : 'New Log'}</TabButton>
        <TabButton active={tab === 'dash'} onClick={() => setTab('dash')} icon={<Gauge size={16} />}>{ar ? 'الملخص والسجلات' : 'Overview & Logs'}</TabButton>
        {isAdmin && <TabButton active={tab === 'config'} onClick={() => setTab('config')} icon={<Settings size={16} />}>{ar ? 'الإعدادات' : 'Configuration'}</TabButton>}
      </div>

      {/* ===== Section 1: New Technical Log ===== */}
      {tab === 'new' && (
      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-6 md:p-9 shadow-sm">
        <div className="flex items-start gap-3 mb-7">
          <ClipboardList className="text-brand mt-0.5 shrink-0" size={26} />
          <div>
            <h2 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">{ar ? 'مهمة تقنية جديدة' : 'New Technical Log'}</h2>
            <p className="text-zinc-400 font-medium text-sm mt-0.5">{ar ? 'التاريخ والوقت يُسجّلان تلقائياً.' : 'Date & time are recorded automatically.'}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
          {/* Log Type — full width */}
          <div className="md:col-span-2">
            <label className={label}>{ar ? 'نوع السجل:' : 'Log Type:'}</label>
            <div className="relative">
              <div className={cn(field, "flex items-center pe-11")}>Technical Log</div>
              <ChevronDown size={18} className="absolute end-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            </div>
          </div>

          <div>
            <label className={label}>{ar ? 'نوع المهمة:' : 'Technical Task Type:'} <span className="text-brand">*</span></label>
            <SelectField value={activityType} onChange={(e) => setActivityType(e.target.value)}>
              <option value="">{ar ? 'اختر المهمة...' : 'Select task...'}</option>
              {activities.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </SelectField>
          </div>

          <div>
            <label className={label}>{ar ? 'الحالة:' : 'Status:'} <span className="text-brand">*</span></label>
            <SelectField value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{ar ? 'اختر الحالة...' : 'Select status...'}</option>
              {statuses.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
            </SelectField>
          </div>

          <div>
            <label className={label}>{ar ? 'الوقت المستغرق (دقائق):' : 'Time Spent (minutes):'} <span className="text-brand">*</span></label>
            <input type="number" min={0} value={minutes || ''} onChange={(e) => setMinutes(Math.max(0, Number(e.target.value)))}
              placeholder={ar ? 'مثال: 15' : 'e.g. 15'} className={field} />
            <div className="flex flex-wrap gap-2 mt-2.5">
              {QUICK_MINS.map((m) => (
                <button key={m} type="button" onClick={() => setMinutes(m)}
                  className={cn("px-3.5 py-1.5 rounded-lg text-xs font-black transition",
                    minutes === m ? "bg-brand text-white" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand")}>
                  {m}m
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={label}>{ar ? 'البراند:' : 'Brand:'}</label>
            <SelectField value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">{ar ? '— اختر —' : '— Select —'}</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </SelectField>
          </div>

          <div className="md:col-span-2">
            <label className={label}>{ar ? 'ملاحظات:' : 'Notes:'}</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              placeholder={ar ? 'ملاحظات...' : 'Notes...'}
              className={cn(field, "resize-none font-medium")} />
          </div>
        </div>

        <button onClick={save} disabled={!canSave}
          className="mt-7 w-full inline-flex items-center justify-center gap-2.5 px-8 py-4 rounded-2xl bg-brand text-white text-base font-black hover:bg-brand-dark disabled:opacity-50 transition-all active:scale-[0.99]">
          {saving ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          {ar ? 'حفظ السجل' : 'Save Log'}
        </button>
      </div>
      )}

      {/* ===== Section 2 & 3: Overview + Logs (own tab) ===== */}
      {tab === 'dash' && (
      <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-black text-zinc-900 dark:text-white flex items-center gap-2"><Gauge className="text-brand" size={18} /> {ar ? 'ملخص اليوم' : 'Overview'}</h2>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="px-3 py-1.5 rounded-xl bg-white dark:bg-zinc-800 border-2 border-zinc-100 dark:border-zinc-700 text-sm font-bold outline-none focus:border-brand text-zinc-900 dark:text-white" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard icon={<ListChecks size={18} />} label={ar ? 'إجمالي المهام' : 'Total Tasks'} value={summary?.totals?.total_tasks ?? 0} />
        <StatCard icon={<Clock size={18} />} label={ar ? 'ساعات الإنتاجية' : 'Productive Hours'} value={`${hours(summary?.totals?.productive_seconds)}h`} accent />
        <StatCard icon={<Activity size={18} />} label={ar ? 'إجمالي الوقت' : 'Total Logged'} value={`${hours(summary?.totals?.total_seconds)}h`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Technical Tasks Status */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-5">
          <h3 className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-3">{ar ? 'المهام حسب الحالة' : 'Technical Tasks Status'}</h3>
          <div className="space-y-2">
            {(summary?.byStatus || []).length === 0 && <p className="text-zinc-400 text-xs font-bold py-4 text-center">{ar ? 'لا توجد بيانات' : 'No data'}</p>}
            {(summary?.byStatus || []).map((s: any) => (
              <div key={s.status} className="flex items-center justify-between gap-2">
                <span className={cn("text-xs font-black px-2.5 py-1 rounded-lg", statusColor(s.status))}>{s.status}</span>
                <span className="font-black text-zinc-900 dark:text-white">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
        {/* By activity */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-5">
          <h3 className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-3">{ar ? 'المهام حسب النوع' : 'Tasks by Type'}</h3>
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {(summary?.byActivity || []).length === 0 && <p className="text-zinc-400 text-xs font-bold py-4 text-center">{ar ? 'لا توجد بيانات' : 'No data'}</p>}
            {(summary?.byActivity || []).map((a: any) => (
              <div key={a.activity_type} className="flex items-center justify-between gap-2 text-sm">
                <span className="font-bold text-zinc-700 dark:text-zinc-300 truncate">{a.activity_type}</span>
                <span className="shrink-0 text-zinc-400 font-bold text-xs">{a.count} · {fmtDur(a.seconds)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Per-agent (admins) */}
      {isAdmin && (summary?.byAgent || []).length > 0 && (
        <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-5">
          <h3 className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-3">{ar ? 'الموظفون (ساعات العمل الفعلي)' : 'Employees (Productive Hours)'}</h3>
          <div className="space-y-1.5">
            {summary.byAgent.map((a: any) => (
              <div key={a.agent_name} className="flex items-center justify-between gap-2 text-sm border-b border-zinc-50 dark:border-zinc-800 py-1.5">
                <span className="font-black text-zinc-900 dark:text-white">{a.agent_name}</span>
                <span className="text-zinc-500 font-bold text-xs">{a.tasks} {ar ? 'مهمة' : 'tasks'} · <span className="text-brand font-black">{hours(a.productive_seconds)}h</span></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== Section 3: Team Logs ===== */}
      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="font-black text-zinc-900 dark:text-white">{isAdmin ? (ar ? 'سجلات الفريق' : 'Team Logs') : (ar ? 'سجلاتي' : 'My Logs')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] font-black uppercase tracking-widest text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
                <th className="text-left px-5 py-3">{ar ? 'المهمة' : 'Task'}</th>
                <th className="text-left px-3 py-3">{ar ? 'الحالة' : 'Status'}</th>
                <th className="text-left px-3 py-3">{ar ? 'الوقت' : 'Time'}</th>
                <th className="text-left px-3 py-3">{ar ? 'البراند' : 'Brand'}</th>
                {isAdmin && <th className="text-left px-3 py-3">{ar ? 'الموظف' : 'Employee'}</th>}
                <th className="text-left px-3 py-3">{ar ? 'التاريخ' : 'When'}</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={isAdmin ? 6 : 5} className="text-center text-zinc-400 font-bold py-10">{ar ? 'لا توجد سجلات في هذا اليوم' : 'No logs for this day'}</td></tr>
              )}
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-zinc-50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                  <td className="px-5 py-3 font-bold text-zinc-900 dark:text-white">{l.activity_type}{l.notes && <span className="block text-[11px] font-medium text-zinc-400 truncate max-w-xs">{l.notes}</span>}</td>
                  <td className="px-3 py-3"><span className={cn("text-[11px] font-black px-2 py-0.5 rounded-lg", statusColor(l.status))}>{l.status}</span></td>
                  <td className="px-3 py-3 font-black text-zinc-700 dark:text-zinc-300">{fmtDur(l.duration_seconds)}</td>
                  <td className="px-3 py-3 text-zinc-500 font-bold text-xs">{l.brand_name || '—'}</td>
                  {isAdmin && <td className="px-3 py-3 text-zinc-500 font-bold text-xs">{l.agent_name}</td>}
                  <td className="px-3 py-3 text-zinc-400 font-bold text-xs whitespace-nowrap">{formatDate(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </div>
      )}

      {/* ===== Section 4: Configuration (admins, own tab) ===== */}
      {tab === 'config' && isAdmin && (
        <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-brand/30 p-6 space-y-6">
          <h2 className="font-black text-zinc-900 dark:text-white flex items-center gap-2"><Settings className="text-brand" size={18} /> {ar ? 'إعدادات القوائم' : 'Configuration'}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Activities */}
            <div>
              <h3 className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-2">{ar ? 'أنواع المهام' : 'Task Types'}</h3>
              <div className="flex gap-2 mb-3">
                <input value={newActivity} onChange={(e) => setNewActivity(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addActivity()} placeholder={ar ? 'نوع جديد...' : 'New type...'} className={cn(field, "flex-1")} />
                <button onClick={addActivity} className="px-4 rounded-xl bg-brand text-white font-black"><Plus size={16} /></button>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {activities.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-800">
                    <span className="text-sm font-bold text-zinc-700 dark:text-zinc-200 truncate">{a.name}</span>
                    <button onClick={() => delActivity(a.id)} className="text-zinc-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
            {/* Statuses */}
            <div>
              <h3 className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-2">{ar ? 'الحالات' : 'Statuses'}</h3>
              <div className="flex gap-2 mb-2">
                <input value={newStatus} onChange={(e) => setNewStatus(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addStatus()} placeholder={ar ? 'حالة جديدة...' : 'New status...'} className={cn(field, "flex-1")} />
                <button onClick={addStatus} className="px-4 rounded-xl bg-brand text-white font-black"><Plus size={16} /></button>
              </div>
              <label className="flex items-center gap-2 mb-3 text-xs font-bold text-zinc-500 cursor-pointer">
                <input type="checkbox" checked={newStatusCounts} onChange={(e) => setNewStatusCounts(e.target.checked)} />
                {ar ? 'تُحتسب في وقت الإنتاجية (مثل Completed)' : 'Counts toward productive time (like Completed)'}
              </label>
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {statuses.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-800">
                    <span className="text-sm font-bold text-zinc-700 dark:text-zinc-200 truncate">{s.name}{s.counts_time && <span className="ml-2 text-[9px] font-black text-emerald-600 uppercase">{ar ? 'إنتاجي' : 'productive'}</span>}</span>
                    <button onClick={() => delStatus(s.id)} className="text-zinc-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn("inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-black whitespace-nowrap transition-all",
        active ? "bg-white dark:bg-zinc-900 text-brand shadow-sm" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")}>
      {icon} {children}
    </button>
  );
}

function SelectField({ value, onChange, children }: { value: string; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <select value={value} onChange={onChange}
        className="w-full px-5 py-4 pe-11 rounded-2xl bg-zinc-50 dark:bg-zinc-800 text-[15px] font-bold outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white appearance-none cursor-pointer">
        {children}
      </select>
      <ChevronDown size={18} className="absolute end-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
    </div>
  );
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: any; accent?: boolean }) {
  return (
    <div className={cn("rounded-3xl border p-5", accent ? "bg-brand/5 border-brand/20" : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800")}>
      <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center mb-3", accent ? "bg-brand/15 text-brand" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500")}>{icon}</div>
      <div className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">{value}</div>
      <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400 mt-0.5">{label}</div>
    </div>
  );
}
