import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { useFetch } from '../../hooks/useFetch';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Send, Loader2, Play, CheckCheck, Pencil, Trash2, Plus, CheckCircle2, XCircle } from 'lucide-react';

// Assign Task / My Tasks / Task Tracker — self-contained, rendered as tabs inside TaskView.
const QUICK = [5, 10, 15, 30, 45, 60];
const label = "block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2";
const field = "w-full px-4 py-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800 text-sm font-bold outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white";

const toLocalInput = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export default function AssignedTasksView({ mode }: { mode: 'assign' | 'mytasks' | 'tracker' }) {
  const { lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const lastMessage = useWebSocket();
  const ar = lang === 'ar';
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  const [assignees, setAssignees] = useState<any[]>([]);
  const fetchAssignees = async () => { try { const r = await fetchWithAuth(`${API_URL}/assigned-tasks/assignees`); if (r.ok) setAssignees(await r.json()); } catch { /* ignore */ } };

  // ---- assign form ----
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [requireTime, setRequireTime] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveAssign = async () => {
    if (!title.trim() || !assignTo || saving) return;
    setSaving(true);
    try {
      const r = await fetchWithAuth(`${API_URL}/assigned-tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), description: desc.trim() || null, assigned_to: Number(assignTo), due_date: due || null, priority, require_time_entry: requireTime }) });
      if (r.ok) { setToast({ msg: ar ? 'تم تعيين المهمة ✓' : 'Task assigned ✓', ok: true }); setTitle(''); setDesc(''); setAssignTo(''); setDue(''); setPriority('Medium'); setRequireTime(true); }
      else { const e = await r.json().catch(() => ({})); setToast({ msg: e.error || (ar ? 'فشل' : 'Failed'), ok: false }); }
    } catch { setToast({ msg: ar ? 'فشل' : 'Failed', ok: false }); } finally { setSaving(false); }
  };

  // ---- my tasks ----
  const [myTasks, setMyTasks] = useState<any[]>([]);
  const fetchMine = async () => { try { const r = await fetchWithAuth(`${API_URL}/assigned-tasks/mine`); if (r.ok) setMyTasks(await r.json()); } catch { /* ignore */ } };
  const [completeTask, setCompleteTask] = useState<any | null>(null);
  const [cMinutes, setCMinutes] = useState(0);
  const [cNote, setCNote] = useState('');
  const [cSaving, setCSaving] = useState(false);
  const setStatus = async (t: any, status: string) => {
    try { const r = await fetchWithAuth(`${API_URL}/assigned-tasks/${t.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); if (r.ok) fetchMine(); } catch { /* ignore */ }
  };
  const openComplete = (t: any) => {
    if (t.due_date && new Date(t.due_date).getTime() > Date.now() && !window.confirm(ar ? 'المهمة لم يحن موعدها بعد. هل أنت متأكد من الإنهاء؟' : "This task isn't due yet. Complete anyway?")) return;
    setCompleteTask(t); setCMinutes(0); setCNote('');
  };
  const saveComplete = async () => {
    if (!completeTask || cSaving) return;
    if (completeTask.require_time_entry && cMinutes <= 0) { setToast({ msg: ar ? 'أدخل الوقت (دقائق > 0)' : 'Enter time (minutes > 0)', ok: false }); return; }
    setCSaving(true);
    try {
      const r = await fetchWithAuth(`${API_URL}/assigned-tasks/${completeTask.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Completed', minutes: cMinutes, note: cNote.trim() || null }) });
      if (r.ok) { setToast({ msg: ar ? 'تم الإنجاز ✓' : 'Completed ✓', ok: true }); setCompleteTask(null); fetchMine(); }
      else { const e = await r.json().catch(() => ({})); setToast({ msg: e.error || (ar ? 'فشل' : 'Failed'), ok: false }); }
    } catch { setToast({ msg: ar ? 'فشل' : 'Failed', ok: false }); } finally { setCSaving(false); }
  };

  // ---- tracker ----
  const [allTasks, setAllTasks] = useState<any[]>([]);
  const fetchAll = async () => { try { const r = await fetchWithAuth(`${API_URL}/assigned-tasks`); if (r.ok) setAllTasks(await r.json()); } catch { /* ignore */ } };
  const [editTask, setEditTask] = useState<any | null>(null);
  const [eTitle, setETitle] = useState(''); const [eDesc, setEDesc] = useState(''); const [eAssign, setEAssign] = useState(''); const [ePriority, setEPriority] = useState('Medium'); const [eDue, setEDue] = useState(''); const [eSaving, setESaving] = useState(false);
  const openEdit = (t: any) => { setEditTask(t); setETitle(t.title); setEDesc(t.description || ''); setEAssign(String(t.assigned_to)); setEPriority(t.priority); setEDue(t.due_date ? toLocalInput(t.due_date) : ''); };
  const saveEdit = async () => {
    if (!editTask || !eTitle.trim() || !eAssign || eSaving) return;
    setESaving(true);
    try {
      const r = await fetchWithAuth(`${API_URL}/assigned-tasks/${editTask.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: eTitle.trim(), description: eDesc.trim() || null, assigned_to: Number(eAssign), priority: ePriority, due_date: eDue || null }) });
      if (r.ok) { setToast({ msg: ar ? 'تم التعديل ✓' : 'Updated ✓', ok: true }); setEditTask(null); fetchAll(); }
      else { const e = await r.json().catch(() => ({})); setToast({ msg: e.error || (ar ? 'فشل' : 'Failed'), ok: false }); }
    } catch { /* ignore */ } finally { setESaving(false); }
  };
  const del = async (t: any) => {
    if (!window.confirm(ar ? `حذف المهمة "${t.title}"؟` : `Delete task "${t.title}"?`)) return;
    try { const r = await fetchWithAuth(`${API_URL}/assigned-tasks/${t.id}`, { method: 'DELETE' }); if (r.ok) fetchAll(); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (mode === 'assign') fetchAssignees();
    if (mode === 'mytasks') { fetchMine(); fetchWithAuth(`${API_URL}/assigned-tasks/seen`, { method: 'POST' }).catch(() => {}); }
    if (mode === 'tracker') { fetchAll(); fetchAssignees(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => {
    if (lastMessage?.type === 'ASSIGNED_TASKS_UPDATED') { if (mode === 'mytasks') fetchMine(); if (mode === 'tracker') fetchAll(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage]);

  const priorityCls = (p: string) => p === 'High' ? 'text-red-600 bg-red-50 dark:bg-red-900/20' : p === 'Low' ? 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800' : 'text-amber-600 bg-amber-50 dark:bg-amber-900/20';
  const statusCls = (s: string) => s === 'Completed' ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20' : s === 'In Progress' ? 'text-amber-600 bg-amber-50 dark:bg-amber-900/20' : 'text-blue-600 bg-blue-50 dark:bg-blue-900/20';
  const isOverdue = (t: any) => t.due_date && t.status !== 'Completed' && new Date(t.due_date).getTime() < Date.now();
  const fmtDur = (s: number) => { const m = Math.round((Number(s) || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
  const priorityBtns = (val: string, set: (p: string) => void) => (
    <div className="flex gap-2">{['High', 'Medium', 'Low'].map((p) => (
      <button key={p} type="button" onClick={() => set(p)} className={cn('px-4 py-2 rounded-xl text-sm font-black transition', val === p ? priorityCls(p) + ' ring-2 ring-current' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>{p}</button>
    ))}</div>
  );

  const Toast = toast ? (
    <div className={cn("fixed top-6 right-6 z-[220] px-5 py-3 rounded-2xl font-black text-sm shadow-2xl flex items-center gap-2", toast.ok ? "bg-emerald-600 text-white" : "bg-red-500 text-white")}>
      {toast.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}{toast.msg}
    </div>
  ) : null;

  if (mode === 'assign') {
    const canSave = !!title.trim() && !!assignTo && !saving;
    return (<div>{Toast}
      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-6 md:p-8 max-w-3xl">
        <h2 className="text-xl font-black text-zinc-900 dark:text-white mb-5 flex items-center gap-2"><Plus className="text-brand" size={20} />{ar ? 'تعيين مهمة' : 'Assign Task'}</h2>
        <div className="space-y-4">
          <div><label className={label}>{ar ? 'العنوان' : 'Title'} <span className="text-brand">*</span></label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder={ar ? 'عنوان المهمة...' : 'Task title...'} /></div>
          <div><label className={label}>{ar ? 'الوصف' : 'Description'}</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} className={cn(field, 'resize-none font-medium')} placeholder={ar ? 'اختياري...' : 'Optional...'} /></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={label}>{ar ? 'المُعيَّن له' : 'Assign To'} <span className="text-brand">*</span></label>
              <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className={field}>
                <option value="">{ar ? 'اختر موظفاً...' : 'Select employee...'}</option>
                {assignees.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
              </select></div>
            <div><label className={label}>{ar ? 'موعد التسليم' : 'Due Date & Time'}</label>
              <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={field} /></div>
          </div>
          <div><label className={label}>{ar ? 'الأولوية' : 'Priority'}</label>{priorityBtns(priority, setPriority)}</div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={requireTime} onChange={(e) => setRequireTime(e.target.checked)} className="w-4 h-4 accent-[color:var(--color-brand)]" />
            <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300">{ar ? 'طلب تسجيل الوقت عند الإنهاء' : 'Require time entry to complete'}</span>
          </label>
        </div>
        <button onClick={saveAssign} disabled={!canSave} className="mt-6 w-full md:w-auto inline-flex items-center justify-center gap-2 px-8 py-3 rounded-2xl bg-brand text-white font-black hover:bg-brand-dark disabled:opacity-50 transition">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}{ar ? 'تعيين' : 'Assign'}
        </button>
      </div></div>);
  }

  if (mode === 'mytasks') {
    return (<div className="space-y-3">{Toast}
      {myTasks.length === 0 && <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-12 text-center text-zinc-400 font-bold">{ar ? 'لا توجد مهام معيّنة لك' : 'No tasks assigned to you'}</div>}
      {myTasks.map((t) => (
        <div key={t.id} className={cn("bg-white dark:bg-zinc-900 rounded-2xl border p-4", isOverdue(t) ? "border-red-300 dark:border-red-900/50" : "border-zinc-200 dark:border-zinc-800")}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className={cn("text-[10px] font-black px-2 py-0.5 rounded-md", priorityCls(t.priority))}>{t.priority}</span>
                <span className={cn("text-[10px] font-black px-2 py-0.5 rounded-md", statusCls(t.status))}>{t.status}</span>
                {isOverdue(t) && <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-red-600 bg-red-50 dark:bg-red-900/20">{ar ? 'متأخرة' : 'overdue'}</span>}
              </div>
              <p className="font-black text-zinc-900 dark:text-white">{t.title}</p>
              {t.description && <p className="text-sm text-zinc-500 font-medium mt-0.5">{t.description}</p>}
              <p className="text-xs text-zinc-400 font-bold mt-1">{ar ? 'من' : 'By'}: {t.assigned_by_name}{t.due_date && <> · {ar ? 'الموعد' : 'Due'}: {formatDate(t.due_date)}</>}</p>
              {t.status === 'Completed' && <p className="text-xs text-emerald-600 font-black mt-1">{ar ? 'الوقت' : 'Time'}: {fmtDur(t.duration_seconds)}{t.note && <span className="text-zinc-400 font-medium"> — {t.note}</span>}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {t.status === 'New' && <button onClick={() => setStatus(t, 'In Progress')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-black active:scale-95"><Play size={14} />{ar ? 'ابدأ' : 'Start'}</button>}
              {t.status === 'In Progress' && <button onClick={() => openComplete(t)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-sm font-black active:scale-95"><CheckCheck size={14} />{ar ? 'إنهاء' : 'Complete'}</button>}
            </div>
          </div>
        </div>
      ))}
      {completeTask && (
        <div className="fixed inset-0 z-[220] bg-black/40 flex items-center justify-center p-4" onClick={() => setCompleteTask(null)}>
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-black text-zinc-900 dark:text-white mb-0.5">{ar ? 'إنهاء المهمة' : 'Complete Task'}</h3>
            <p className="text-zinc-400 text-sm font-bold mb-4 truncate">{completeTask.title}</p>
            <label className={label}>{ar ? 'الوقت المستغرق (دقائق)' : 'Time Spent (minutes)'}{completeTask.require_time_entry && <span className="text-brand"> *</span>}</label>
            <input type="number" min={0} value={cMinutes || ''} onChange={(e) => setCMinutes(Math.max(0, Number(e.target.value)))} className={field} placeholder={ar ? 'مثال: 15' : 'e.g. 15'} />
            <div className="flex flex-wrap gap-2 mt-2.5">{QUICK.map((m) => <button key={m} type="button" onClick={() => setCMinutes(m)} className={cn("px-3 py-1.5 rounded-lg text-xs font-black", cMinutes === m ? "bg-brand text-white" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500")}>{m}m</button>)}</div>
            <div className="h-4" />
            <label className={label}>{ar ? 'ملاحظة الإنجاز' : 'Completion Note'}</label>
            <textarea value={cNote} onChange={(e) => setCNote(e.target.value)} rows={2} className={cn(field, 'resize-none font-medium')} placeholder={ar ? 'اختياري...' : 'Optional...'} />
            <div className="flex gap-2 mt-6">
              <button onClick={() => setCompleteTask(null)} className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black text-sm">{ar ? 'إلغاء' : 'Cancel'}</button>
              <button onClick={saveComplete} disabled={cSaving} className="flex-1 px-4 py-2.5 rounded-xl bg-brand text-white font-black text-sm disabled:opacity-50 inline-flex items-center justify-center gap-2">{cSaving ? <Loader2 size={16} className="animate-spin" /> : <CheckCheck size={16} />}{ar ? 'إنهاء' : 'Complete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>);
  }

  // tracker
  return (<div>{Toast}
    <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800"><h2 className="font-black text-zinc-900 dark:text-white">{ar ? 'متابعة المهام' : 'Task Tracker'}</h2></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-[10px] font-black uppercase tracking-widest text-zinc-400 border-b border-zinc-100 dark:border-zinc-800">
            <th className="text-left px-4 py-3">{ar ? 'المهمة' : 'Task'}</th>
            <th className="text-left px-3 py-3">{ar ? 'المعيَّن له' : 'Assignee'}</th>
            <th className="text-left px-3 py-3">{ar ? 'الأولوية' : 'Priority'}</th>
            <th className="text-left px-3 py-3">{ar ? 'الموعد' : 'Due'}</th>
            <th className="text-left px-3 py-3">{ar ? 'الحالة' : 'Status'}</th>
            <th className="text-left px-3 py-3">{ar ? 'الوقت' : 'Time'}</th>
            <th className="px-4 py-3"></th>
          </tr></thead>
          <tbody>
            {allTasks.length === 0 && <tr><td colSpan={7} className="text-center text-zinc-400 font-bold py-10">{ar ? 'لا توجد مهام' : 'No tasks'}</td></tr>}
            {allTasks.map((t) => (
              <tr key={t.id} className="border-b border-zinc-50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <td className="px-4 py-3"><div className="font-black text-zinc-900 dark:text-white">{t.title}</div>{t.description && <div className="text-[11px] text-zinc-400 font-medium truncate max-w-xs">{t.description}</div>}<div className="text-[10px] text-zinc-400 font-bold">{ar ? 'من' : 'by'} {t.assigned_by_name}</div></td>
                <td className="px-3 py-3 font-bold text-zinc-600 dark:text-zinc-300 whitespace-nowrap">{t.assigned_to_name}</td>
                <td className="px-3 py-3"><span className={cn("text-[11px] font-black px-2 py-0.5 rounded-md", priorityCls(t.priority))}>{t.priority}</span></td>
                <td className={cn("px-3 py-3 font-bold text-xs whitespace-nowrap", isOverdue(t) ? "text-red-600" : "text-zinc-500")}>{t.due_date ? formatDate(t.due_date) : '—'}{isOverdue(t) && <span className="font-black"> ({ar ? 'متأخرة' : 'overdue'})</span>}</td>
                <td className="px-3 py-3"><span className={cn("text-[11px] font-black px-2 py-0.5 rounded-md", statusCls(t.status))}>{t.status}</span></td>
                <td className="px-3 py-3 text-zinc-500 font-bold text-xs">{t.status === 'Completed' ? fmtDur(t.duration_seconds) : '—'}{t.note && <span className="block text-zinc-400 truncate max-w-[10rem]">{t.note}</span>}</td>
                <td className="px-4 py-3"><div className="flex items-center justify-end gap-1.5">
                  <button onClick={() => openEdit(t)} className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand"><Pencil size={14} /></button>
                  <button onClick={() => del(t)} className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-red-500"><Trash2 size={14} /></button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    {editTask && (
      <div className="fixed inset-0 z-[220] bg-black/40 flex items-center justify-center p-4" onClick={() => setEditTask(null)}>
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-black text-zinc-900 dark:text-white mb-4">{ar ? 'تعديل المهمة' : 'Edit Task'}</h3>
          <div className="space-y-3">
            <div><label className={label}>{ar ? 'العنوان' : 'Title'}</label><input value={eTitle} onChange={(e) => setETitle(e.target.value)} className={field} /></div>
            <div><label className={label}>{ar ? 'الوصف' : 'Description'}</label><textarea value={eDesc} onChange={(e) => setEDesc(e.target.value)} rows={2} className={cn(field, 'resize-none font-medium')} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={label}>{ar ? 'المعيَّن له' : 'Assignee'}</label><select value={eAssign} onChange={(e) => setEAssign(e.target.value)} className={field}>{assignees.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}</select></div>
              <div><label className={label}>{ar ? 'الموعد' : 'Due'}</label><input type="datetime-local" value={eDue} onChange={(e) => setEDue(e.target.value)} className={field} /></div>
            </div>
            <div><label className={label}>{ar ? 'الأولوية' : 'Priority'}</label>{priorityBtns(ePriority, setEPriority)}</div>
          </div>
          <div className="flex gap-2 mt-6">
            <button onClick={() => setEditTask(null)} className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black text-sm">{ar ? 'إلغاء' : 'Cancel'}</button>
            <button onClick={saveEdit} disabled={eSaving} className="flex-1 px-4 py-2.5 rounded-xl bg-brand text-white font-black text-sm disabled:opacity-50 inline-flex items-center justify-center gap-2">{eSaving ? <Loader2 size={16} className="animate-spin" /> : null}{ar ? 'حفظ' : 'Save'}</button>
          </div>
        </div>
      </div>
    )}
  </div>);
}
