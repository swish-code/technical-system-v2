import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn } from '../../lib/utils';
import { Gauge, Loader2, Save } from 'lucide-react';
import { useFetch } from '../../hooks/useFetch';

interface KpiAgent {
  user_id: number;
  username: string;
  tickets: number;
  chats: number;
  total_count: number;
  avg_speed_min: number | null;
  ftr_pct: number | null;
  sla: number | null;
  rating: number | null;
}

// Technical Team KPIs — Manager / Super Visor only. Monthly scorecard for
// Technical Back Office agents: FTR (auto), SLA (manual %), Rating (manual /5,
// shared for the month). Starts from June 2026.
export default function TechnicalKPIView() {
  const { lang } = useAuth();
  const { fetchWithAuth } = useFetch();

  const t = {
    en: {
      title: 'Technical Team KPIs', subtitle: 'Monthly performance — Technical Back Office',
      month: 'Month', ftrTarget: 'FTR target (min)', rating: 'Rating (/5)', save: 'Save',
      employee: 'Employee', ftr: 'FTR', sla: 'SLA', ratingCol: 'Rating',
      noData: 'No agents found', loading: 'Loading...', speed: 'avg', items: 'items',
      hintTarget: 'Set an FTR target for this month to score speed.',
    },
    ar: {
      title: 'مؤشرات أداء الفريق التقني', subtitle: 'الأداء الشهري — المكتب الخلفي التقني',
      month: 'الشهر', ftrTarget: 'هدف FTR (دقيقة)', rating: 'التقييم (/5)', save: 'حفظ',
      employee: 'الموظف', ftr: 'FTR', sla: 'SLA', ratingCol: 'التقييم',
      noData: 'لا يوجد موظفون', loading: 'جارٍ التحميل...', speed: 'متوسط', items: 'عنصر',
      hintTarget: 'حدد هدف FTR لهذا الشهر لاحتساب السرعة.',
    },
  }[lang];

  // Months from June 2026 → current month (newest first).
  const months = useMemo(() => {
    const out: string[] = [];
    const now = new Date();
    let y = 2026, m = 6;
    const endY = now.getFullYear(), endM = now.getMonth() + 1;
    while (y < endY || (y === endY && m <= endM)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out.reverse();
  }, []);
  const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(lang === 'ar' ? 'ar' : 'en-US', { month: 'long', year: 'numeric' });
  };

  const [month, setMonth] = useState<string>(months[0] || '');
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<KpiAgent[]>([]);
  const [ftrTarget, setFtrTarget] = useState<string>('');
  const [rating, setRating] = useState<string>('');
  const [savingMonth, setSavingMonth] = useState(false);
  const [slaInputs, setSlaInputs] = useState<Record<number, string>>({});
  const [savingSla, setSavingSla] = useState<number | null>(null);

  const fetchData = async () => {
    if (!month) return;
    setLoading(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/reports/technical-kpi?month=${month}`);
      if (res.ok) {
        const data = await res.json();
        setAgents(Array.isArray(data.agents) ? data.agents : []);
        setFtrTarget(data.ftr_target_min != null ? String(data.ftr_target_min) : '');
        setRating(data.rating != null ? String(data.rating) : '');
        const sla: Record<number, string> = {};
        (data.agents || []).forEach((a: KpiAgent) => { sla[a.user_id] = a.sla != null ? String(a.sla) : ''; });
        setSlaInputs(sla);
      }
    } catch (err: any) {
      if (!err?.isAuthError) console.error('Failed to load technical KPIs', err);
    } finally {
      setLoading(false);
    }
  };

  // Refetch only when the selected month changes. Depending on fetchData /
  // fetchWithAuth here would loop forever, since useFetch returns a new
  // function identity on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchData(); }, [month]);

  const saveMonth = async () => {
    setSavingMonth(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/reports/technical-kpi/month`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, ftr_target_min: ftrTarget, rating }),
      });
      if (res.ok) await fetchData();
    } catch (err: any) {
      if (!err?.isAuthError) console.error('Failed to save month values', err);
    } finally {
      setSavingMonth(false);
    }
  };

  const saveSla = async (userId: number) => {
    setSavingSla(userId);
    try {
      const res = await fetchWithAuth(`${API_URL}/reports/technical-kpi/sla`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, user_id: userId, sla: slaInputs[userId] ?? '' }),
      });
      if (res.ok) {
        setAgents(prev => prev.map(a => a.user_id === userId
          ? { ...a, sla: slaInputs[userId] === '' ? null : Number(slaInputs[userId]) } : a));
      }
    } catch (err: any) {
      if (!err?.isAuthError) console.error('Failed to save SLA', err);
    } finally {
      setSavingSla(null);
    }
  };

  const pctColor = (v: number | null) => v == null ? 'text-zinc-400'
    : v >= 80 ? 'text-emerald-600' : v >= 50 ? 'text-amber-600' : 'text-red-500';

  return (
    <div className="max-w-[1400px] mx-auto space-y-6 pb-20">
      {/* Header + month picker */}
      <div className="glass-card p-6 rounded-[2rem] border border-zinc-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-zinc-900 dark:bg-white rounded-2xl text-white dark:text-zinc-900 shrink-0">
            <Gauge size={26} strokeWidth={2.5} />
          </div>
          <div>
            <h2 className="text-2xl md:text-3xl font-black text-zinc-900 dark:text-white tracking-tight">{t.title}</h2>
            <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-0.5">{t.subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{t.month}</span>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-sm font-black text-zinc-900 dark:text-white outline-none focus:border-brand"
          >
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
      </div>

      {/* Month-level inputs: FTR target + shared Rating */}
      <div className="glass-card p-6 rounded-[2rem] border border-zinc-100 dark:border-zinc-800 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest">{t.ftrTarget}</label>
          <input type="number" min={0} step="0.1" value={ftrTarget} onChange={(e) => setFtrTarget(e.target.value)} placeholder="—"
            className="w-32 px-3 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-sm font-black text-zinc-900 dark:text-white outline-none focus:border-brand" />
        </div>
        <div className="space-y-1.5">
          <label className="block text-[10px] font-black text-zinc-400 uppercase tracking-widest">{t.rating}</label>
          <input type="number" min={0} max={5} step="0.1" value={rating} onChange={(e) => setRating(e.target.value)} placeholder="—"
            className="w-32 px-3 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-sm font-black text-zinc-900 dark:text-white outline-none focus:border-brand" />
        </div>
        <button onClick={saveMonth} disabled={savingMonth}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand text-white text-xs font-black uppercase tracking-widest hover:opacity-90 disabled:opacity-60">
          {savingMonth ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {t.save}
        </button>
        {!ftrTarget && <p className="text-[11px] text-amber-600 font-bold self-center">{t.hintTarget}</p>}
      </div>

      {/* KPI table */}
      <div className="overflow-x-auto rounded-[2rem] border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900/50">
        <table className="w-full text-left border-collapse min-w-[720px]">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-100 dark:border-zinc-800">
              <th className="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{t.employee}</th>
              <th className="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest border-l border-zinc-100 dark:border-zinc-800">{t.ftr}</th>
              <th className="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest border-l border-zinc-100 dark:border-zinc-800">{t.sla}</th>
              <th className="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest border-l border-zinc-100 dark:border-zinc-800">{t.ratingCol}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
            {loading ? (
              <tr><td colSpan={4} className="px-6 py-16 text-center">
                <div className="flex items-center justify-center gap-3 text-zinc-400">
                  <Loader2 size={18} className="animate-spin" />
                  <span className="text-xs font-bold uppercase tracking-widest">{t.loading}</span>
                </div>
              </td></tr>
            ) : agents.length === 0 ? (
              <tr><td colSpan={4} className="px-6 py-16 text-center text-zinc-400 font-bold uppercase tracking-widest text-xs">{t.noData}</td></tr>
            ) : agents.map((a) => (
              <tr key={a.user_id} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30">
                {/* Employee */}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-xs font-black text-zinc-500">
                      {a.username?.[0]?.toUpperCase()}
                    </div>
                    <span className="text-sm font-black text-zinc-900 dark:text-white">{a.username}</span>
                  </div>
                </td>
                {/* FTR (auto) */}
                <td className="px-6 py-4 border-l border-zinc-50 dark:border-zinc-800/50">
                  {a.ftr_pct == null ? (
                    <span className="text-zinc-400 font-bold">—</span>
                  ) : (
                    <span className={cn('text-lg font-black tabular-nums', pctColor(a.ftr_pct))}>{a.ftr_pct}%</span>
                  )}
                  <div className="text-[10px] text-zinc-400 font-bold mt-0.5">
                    {a.total_count > 0 ? `${t.speed} ${a.avg_speed_min}m · ${a.total_count} ${t.items}` : '—'}
                  </div>
                </td>
                {/* SLA (manual, per agent) */}
                <td className="px-6 py-4 border-l border-zinc-50 dark:border-zinc-800/50">
                  <div className="flex items-center gap-2">
                    <input type="number" min={0} max={100} value={slaInputs[a.user_id] ?? ''}
                      onChange={(e) => setSlaInputs(prev => ({ ...prev, [a.user_id]: e.target.value }))}
                      onBlur={() => { if ((slaInputs[a.user_id] ?? '') !== (a.sla != null ? String(a.sla) : '')) saveSla(a.user_id); }}
                      placeholder="—"
                      className="w-20 px-2 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-sm font-black text-zinc-900 dark:text-white outline-none focus:border-brand" />
                    <span className="text-xs font-bold text-zinc-400">%</span>
                    {savingSla === a.user_id && <Loader2 size={14} className="animate-spin text-zinc-400" />}
                  </div>
                </td>
                {/* Rating (manual, shared for the month) */}
                <td className="px-6 py-4 border-l border-zinc-50 dark:border-zinc-800/50">
                  {a.rating == null
                    ? <span className="text-zinc-400 font-bold">—</span>
                    : <span className="text-lg font-black text-zinc-900 dark:text-white tabular-nums">{a.rating} <span className="text-xs text-zinc-400">/ 5</span></span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
