import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { useFetch } from '../../hooks/useFetch';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Send, Loader2, Play, CheckCheck, Pencil, Trash2, Plus, CheckCircle2, XCircle, Repeat, Calendar, Power, Download } from 'lucide-react';
import * as XLSX from 'xlsx';

// Assign Task / My Tasks / Task Tracker — self-contained, rendered as tabs inside TaskView.
const QUICK = [5, 10, 15, 30, 45, 60];
const label = "block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2";
const field = "w-full px-4 py-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800 text-sm font-bold outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white";

const toLocalInput = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export default function AssignedTasksView({ mode, onShift }: { mode: 'assign' | 'mytasks' | 'tracker' | 'available' | 'recurring'; onShift?: boolean }) {
  const { lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const lastMessage = useWebSocket();
  const ar = lang === 'ar';
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  const [assignees, setAssignees] = useState<any[]>([]);
  const fetchAssignees = async () => { try { const r = await fetchWithAuth(`${API_URL}/assigned-tasks/assignees`); if (r.ok) setAssignees(await r.json()); } catch { /* ignore */ } };
  const [activities, setActivities] = useState<any[]>([]);
  const fetchActivities = async () => { try { const r = await fetchWithAuth(`${API_URL}/task-config`); if (r.ok) { const d = await r.json(); setActivities(d.activities || []); } } catch { /* ignore */ } };

  // ---- assign form ----
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [due, setDue] = useState('');
  const [taskType, setTaskType] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [requireTime, setRequireTime] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveAssign = async () => {
    if (!assignTo || saving) return;
    setSaving(true);
    try {
      const r = await fetchWithAuth(`${API_URL}/assigned-tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), description: desc.trim() || null, assigned_to: Number(assignTo), task_type: taskType || null, due_date: due || null, priority, require_time_entry: requireTime }) });
      if (r.ok) { setToast({ msg: ar ? 'تم تعيين المهمة ✓' : 'Task assigned ✓', ok: true }); setTitle(''); setDesc(''); setAssignTo(''); setTaskType(''); setDue(''); setPriority('Medium'); setRequireTime(true); }
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
  const [eTitle, setETitle] = useState(''); const [eDesc, setEDesc] = useState(''); const [eAssign, setEAssign] = useState(''); const [eTaskType, setETaskType] = useState(''); const [ePriority, setEPriority] = useState('Medium'); const [eDue, setEDue] = useState(''); const [eSaving, setESaving] = useState(false);
  const openEdit = (t: any) => { setEditTask(t); setETitle(t.title); setEDesc(t.description || ''); setEAssign(String(t.assigned_to)); setETaskType(t.task_type || ''); setEPriority(t.priority); setEDue(t.due_date ? toLocalInput(t.due_date) : ''); };
  const saveEdit = async () => {
    if (!editTask || !eTitle.trim() || !eAssign || eSaving) return;
    setESaving(true);
    try {
      const r = await fetchWithAuth(`${API_URL}/assigned-tasks/${editTask.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: eTitle.trim(), description: eDesc.trim() || null, assigned_to: Number(eAssign), task_type: eTaskType || null, priority: ePriority, due_date: eDue || null }) });
      if (r.ok) { setToast({ msg: ar ? 'تم التعديل ✓' : 'Updated ✓', ok: true }); setEditTask(null); fetchAll(); }
      else { const e = await r.json().catch(() => ({})); setToast({ msg: e.error || (ar ? 'فشل' : 'Failed'), ok: false }); }
    } catch { /* ignore */ } finally { setESaving(false); }
  };
  const del = async (t: any) => {
    if (!window.confirm(ar ? `حذف المهمة "${t.title}"؟` : `Delete task "${t.title}"?`)) return;
    try {
      const r = await fetchWithAuth(`${API_URL}/assigned-tasks/${t.id}`, { method: 'DELETE' });
      if (r.ok) { setToast({ msg: ar ? 'تم الحذف ✓' : 'Deleted ✓', ok: true }); fetchAll(); }
      else { const e = await r.json().catch(() => ({})); setToast({ msg: e.error || (ar ? 'فشل الحذف' : 'Delete failed'), ok: false }); }
    } catch { setToast({ msg: ar ? 'فشل الحذف' : 'Delete failed', ok: false }); }
  };
  // Export the full task list (all columns) to an Excel file.
  const exportTasks = () => {
    const rows = (allTasks || []).map((t: any) => ({
      ID: t.id,
      Title: t.title || '',
      Type: t.task_type || '',
      Description: t.description || '',
      Status: t.status || '',
      Priority: t.priority || '',
      Assignee: t.assigned_to_name || '',
      'Assigned By': t.assigned_by_name || '',
      Department: t.department || '',
      Recurring: t.template_id ? 'Yes' : 'No',
      'Task Date': t.task_date || '',
      'Due Date': t.due_date ? formatDate(t.due_date) : '',
      'Created At': t.created_at ? formatDate(t.created_at) : '',
      'Completed At': t.completed_at ? formatDate(t.completed_at) : '',
      'Duration (min)': t.duration_seconds ? Math.round(Number(t.duration_seconds) / 60) : '',
      Note: t.note || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tasks');
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `tasks-${today}.xlsx`);
  };

  // ---- pool (Available Tasks) ----
  const [pool, setPool] = useState<any[]>([]);
  const [claiming, setClaiming] = useState<number | null>(null);
  const fetchPool = async () => { try { const r = await fetchWithAuth(`${API_URL}/assigned-tasks/available`); if (r.ok) setPool(await r.json()); } catch { /* ignore */ } };
  const claim = async (t: any) => {
    setClaiming(t.id);
    try {
      const r = await fetchWithAuth(`${API_URL}/assigned-tasks/${t.id}/claim`, { method: 'POST' });
      if (r.ok) setToast({ msg: ar ? 'تم سحب المهمة ✓ — تجدها في «مهامي»' : 'Task claimed ✓ — see it in My Tasks', ok: true });
      else { const e = await r.json().catch(() => ({})); setToast({ msg: e.error || (ar ? 'فشل' : 'Failed'), ok: false }); }
      fetchPool();
    } catch { /* ignore */ } finally { setClaiming(null); }
  };

  // ---- recurring templates ----
  const [templates, setTemplates] = useState<any[]>([]);
  const fetchTemplates = async () => { try { const r = await fetchWithAuth(`${API_URL}/task-templates`); if (r.ok) setTemplates(await r.json()); } catch { /* ignore */ } };
  const [tId, setTId] = useState<number | null>(null);
  const [tTitle, setTTitle] = useState(''); const [tDesc, setTDesc] = useState(''); const [tType, setTType] = useState('');
  const [tRec, setTRec] = useState<'daily' | 'days'>('daily'); const [tDays, setTDays] = useState<number[]>([]);
  const [tDue, setTDue] = useState('17:00'); const [tPriority, setTPriority] = useState('Medium');
  const [tMode, setTMode] = useState<'pool' | 'auto'>('pool'); const [tReq, setTReq] = useState(true);
  const [tSaving, setTSaving] = useState(false);
  const resetTemplate = () => { setTId(null); setTTitle(''); setTDesc(''); setTType(''); setTRec('daily'); setTDays([]); setTDue('17:00'); setTPriority('Medium'); setTMode('pool'); setTReq(true); };
  const editTemplate = (t: any) => {
    setTId(t.id); setTTitle(t.title); setTDesc(t.description || ''); setTType(t.task_type || '');
    setTRec(t.recurrence === 'days' ? 'days' : 'daily');
    setTDays(String(t.days || '').split(',').filter(Boolean).map(Number));
    setTDue(t.due_time || '17:00'); setTPriority(t.priority); setTMode(t.assign_mode === 'auto' ? 'auto' : 'pool'); setTReq(t.require_time_entry !== false);
  };
  const saveTemplate = async () => {
    if (!tTitle.trim() || tSaving) return;
    if (tRec === 'days' && tDays.length === 0) { setToast({ msg: ar ? 'اختر يوماً واحداً على الأقل' : 'Pick at least one day', ok: false }); return; }
    setTSaving(true);
    try {
      const body = JSON.stringify({ title: tTitle.trim(), description: tDesc.trim() || null, task_type: tType || null, recurrence: tRec, days: tDays, due_time: tDue, priority: tPriority, assign_mode: tMode, require_time_entry: tReq });
      const r = await fetchWithAuth(`${API_URL}/task-templates${tId ? `/${tId}` : ''}`, { method: tId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (r.ok) { setToast({ msg: tId ? (ar ? 'تم التعديل ✓' : 'Updated ✓') : (ar ? 'تم إنشاء القالب ✓' : 'Template created ✓'), ok: true }); resetTemplate(); fetchTemplates(); }
      else { const e = await r.json().catch(() => ({})); setToast({ msg: e.error || (ar ? 'فشل' : 'Failed'), ok: false }); }
    } catch { /* ignore */ } finally { setTSaving(false); }
  };
  const toggleTemplate = async (t: any) => {
    try { const r = await fetchWithAuth(`${API_URL}/task-templates/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !t.active }) }); if (r.ok) fetchTemplates(); } catch { /* ignore */ }
  };
  const delTemplate = async (t: any) => {
    if (!window.confirm(ar ? `حذف القالب "${t.title}"؟` : `Delete template "${t.title}"?`)) return;
    try { const r = await fetchWithAuth(`${API_URL}/task-templates/${t.id}`, { method: 'DELETE' }); if (r.ok) fetchTemplates(); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (mode === 'assign') { fetchAssignees(); fetchActivities(); }
    if (mode === 'mytasks') { fetchMine(); fetchWithAuth(`${API_URL}/assigned-tasks/seen`, { method: 'POST' }).catch(() => {}); }
    if (mode === 'tracker') { fetchAll(); fetchAssignees(); fetchActivities(); }
    if (mode === 'available') fetchPool();
    if (mode === 'recurring') { fetchTemplates(); fetchActivities(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => {
    if (lastMessage?.type === 'ASSIGNED_TASKS_UPDATED') {
      if (mode === 'mytasks') fetchMine(); if (mode === 'tracker') fetchAll(); if (mode === 'available') fetchPool();
    }
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
    const canSave = !!assignTo && !saving;
    return (<div>{Toast}
      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-6 md:p-8 max-w-3xl">
        <h2 className="text-xl font-black text-zinc-900 dark:text-white mb-5 flex items-center gap-2"><Plus className="text-brand" size={20} />{ar ? 'تعيين مهمة' : 'Assign Task'}</h2>
        <div className="space-y-4">
          <div><label className={label}>{ar ? 'نوع المهمة' : 'Task Type'}</label>
            <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className={field}>
              <option value="">{ar ? '— اختر —' : '— Select —'}</option>
              {activities.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select></div>
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
          <div><label className={label}>{ar ? 'العنوان' : 'Title'}</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder={ar ? 'اختياري...' : 'Optional...'} /></div>
          <div><label className={label}>{ar ? 'الوصف' : 'Description'}</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} className={cn(field, 'resize-none font-medium')} placeholder={ar ? 'اختياري...' : 'Optional...'} /></div>
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
                {t.title && t.task_type && <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-brand bg-brand/10">{t.task_type}</span>}
                {isOverdue(t) && <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-red-600 bg-red-50 dark:bg-red-900/20">{ar ? 'متأخرة' : 'overdue'}</span>}
              </div>
              <p className="font-black text-zinc-900 dark:text-white">{t.title || t.task_type || (ar ? 'مهمة' : 'Task')}</p>
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

  if (mode === 'available') {
    return (<div className="space-y-3">{Toast}
      {!onShift && (
        <div className="rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm font-bold text-amber-700 dark:text-amber-400">
          {ar ? 'يجب أن تكون «على الوردية» لسحب المهام — فعّل المفتاح في أعلى الصفحة.' : 'You must be On Shift to claim tasks — use the toggle at the top of the page.'}
        </div>
      )}
      {pool.length === 0 && <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-12 text-center text-zinc-400 font-bold">{ar ? 'لا توجد مهام متاحة' : 'No available tasks'}</div>}
      {pool.map((t) => (
        <div key={t.id} className={cn("bg-white dark:bg-zinc-900 rounded-2xl border p-4 flex items-start justify-between gap-3 flex-wrap", isOverdue(t) ? "border-red-300 dark:border-red-900/50" : "border-zinc-200 dark:border-zinc-800")}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={cn("text-[10px] font-black px-2 py-0.5 rounded-md", priorityCls(t.priority))}>{t.priority}</span>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-violet-600 bg-violet-50 dark:bg-violet-900/20">{ar ? 'متاحة' : 'Available'}</span>
              {t.task_type && <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-brand bg-brand/10">{t.task_type}</span>}
              {isOverdue(t) && <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-red-600 bg-red-50 dark:bg-red-900/20">{ar ? 'متأخرة' : 'overdue'}</span>}
            </div>
            <p className="font-black text-zinc-900 dark:text-white">{t.title}</p>
            {t.description && <p className="text-sm text-zinc-500 font-medium mt-0.5">{t.description}</p>}
            {t.due_date && <p className="text-xs text-zinc-400 font-bold mt-1">{ar ? 'الموعد' : 'Due'}: {formatDate(t.due_date)}</p>}
          </div>
          <button onClick={() => claim(t)} disabled={!onShift || claiming === t.id}
            className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand text-white text-sm font-black disabled:opacity-50 active:scale-95">
            {claiming === t.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{ar ? 'اسحبها' : 'Claim'}
          </button>
        </div>
      ))}
    </div>);
  }

  if (mode === 'recurring') {
    const DOW = ar ? ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const lead = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
    const firesOn = (dow: number) => templates.filter((t: any) => t.active && (t.recurrence !== 'days' || String(t.days || '').split(',').filter(Boolean).map(Number).includes(dow)));
    return (<div className="space-y-4">{Toast}
      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-6 md:p-8">
        <h2 className="text-xl font-black text-zinc-900 dark:text-white mb-5 flex items-center gap-2"><Repeat className="text-brand" size={20} />{tId ? (ar ? 'تعديل قالب متكرّر' : 'Edit Recurring Template') : (ar ? 'قالب مهمة متكرّرة' : 'New Recurring Template')}</h2>
        <div className="space-y-4">
          <div><label className={label}>{ar ? 'العنوان' : 'Title'} <span className="text-brand">*</span></label>
            <input value={tTitle} onChange={(e) => setTTitle(e.target.value)} className={field} placeholder={ar ? 'عنوان المهمة...' : 'Task title...'} /></div>
          <div><label className={label}>{ar ? 'الوصف' : 'Description'}</label>
            <textarea value={tDesc} onChange={(e) => setTDesc(e.target.value)} rows={2} className={cn(field, 'resize-none font-medium')} placeholder={ar ? 'اختياري...' : 'Optional...'} /></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={label}>{ar ? 'نوع المهمة' : 'Task Type'}</label>
              <select value={tType} onChange={(e) => setTType(e.target.value)} className={field}>
                <option value="">{ar ? '— اختر —' : '— Select —'}</option>
                {activities.map((a: any) => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select></div>
            <div><label className={label}>{ar ? 'وقت التسليم' : 'Due Time'}</label>
              <input type="time" value={tDue} onChange={(e) => setTDue(e.target.value)} className={field} /></div>
          </div>
          <div><label className={label}>{ar ? 'التكرار' : 'Recurrence'}</label>
            <div className="flex gap-2 mb-2">
              <button type="button" onClick={() => setTRec('daily')} className={cn('px-4 py-2 rounded-xl text-sm font-black', tRec === 'daily' ? 'bg-brand text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>{ar ? 'يومياً' : 'Daily'}</button>
              <button type="button" onClick={() => setTRec('days')} className={cn('px-4 py-2 rounded-xl text-sm font-black', tRec === 'days' ? 'bg-brand text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>{ar ? 'أيام محدّدة' : 'Specific days'}</button>
            </div>
            {tRec === 'days' && (
              <div className="flex flex-wrap gap-1.5">
                {DOW.map((d, i) => (
                  <button key={i} type="button" onClick={() => setTDays((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i])}
                    className={cn('px-3 py-1.5 rounded-lg text-xs font-black', tDays.includes(i) ? 'bg-brand text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>{d}</button>
                ))}
              </div>
            )}
          </div>
          <div><label className={label}>{ar ? 'الأولوية' : 'Priority'}</label>{priorityBtns(tPriority, setTPriority)}</div>
          <div><label className={label}>{ar ? 'طريقة التعيين' : 'Assign Mode'}</label>
            <div className="flex gap-2 flex-wrap">
              <button type="button" onClick={() => setTMode('pool')} className={cn('px-4 py-2 rounded-xl text-sm font-black', tMode === 'pool' ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 ring-2 ring-violet-400' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>{ar ? 'Pool — يسحبها الموظف' : 'Pool — agents claim'}</button>
              <button type="button" onClick={() => setTMode('auto')} className={cn('px-4 py-2 rounded-xl text-sm font-black', tMode === 'auto' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 ring-2 ring-emerald-400' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500')}>{ar ? 'Auto — تعيين تلقائي' : 'Auto — least-loaded'}</button>
            </div>
            <p className="text-[11px] text-zinc-400 font-bold mt-1.5">{tMode === 'auto'
              ? (ar ? 'تُعيَّن تلقائياً لأقل موظف عبئاً «على الوردية». إن لم يكن أحد على الوردية → ترجع للـ Pool.' : 'Auto-assigned to the least-loaded On-Shift agent. Nobody On Shift → falls back to the pool.')
              : (ar ? 'تظهر في «المهام المتاحة» وأي موظف على الوردية يسحبها.' : 'Shows in Available Tasks; any On-Shift agent can claim it.')}</p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={tReq} onChange={(e) => setTReq(e.target.checked)} className="w-4 h-4" />
            <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300">{ar ? 'طلب تسجيل الوقت عند الإنهاء' : 'Require time entry to complete'}</span>
          </label>
        </div>
        <div className="flex gap-2 mt-6">
          <button onClick={saveTemplate} disabled={!tTitle.trim() || tSaving} className="inline-flex items-center justify-center gap-2 px-8 py-3 rounded-2xl bg-brand text-white font-black hover:bg-brand-dark disabled:opacity-50">
            {tSaving ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}{tId ? (ar ? 'حفظ' : 'Save') : (ar ? 'إنشاء' : 'Create')}
          </button>
          {tId && <button onClick={resetTemplate} className="px-6 py-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black">{ar ? 'إلغاء' : 'Cancel'}</button>}
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800"><h3 className="font-black text-zinc-900 dark:text-white">{ar ? 'القوالب' : 'Templates'}</h3></div>
        <div className="divide-y divide-zinc-50 dark:divide-zinc-800/50">
          {templates.length === 0 && <p className="text-center text-zinc-400 font-bold py-10">{ar ? 'لا توجد قوالب' : 'No templates'}</p>}
          {templates.map((t: any) => (
            <div key={t.id} className={cn("p-4 flex items-start justify-between gap-3 flex-wrap", !t.active && "opacity-50")}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className={cn("text-[10px] font-black px-2 py-0.5 rounded-md", priorityCls(t.priority))}>{t.priority}</span>
                  <span className={cn("text-[10px] font-black px-2 py-0.5 rounded-md", t.assign_mode === 'auto' ? "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20" : "text-violet-600 bg-violet-50 dark:bg-violet-900/20")}>{t.assign_mode === 'auto' ? 'Auto' : 'Pool'}</span>
                  {t.task_type && <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-brand bg-brand/10">{t.task_type}</span>}
                  {!t.active && <span className="text-[10px] font-black px-2 py-0.5 rounded-md text-zinc-500 bg-zinc-100 dark:bg-zinc-800">{ar ? 'موقوف' : 'paused'}</span>}
                </div>
                <p className="font-black text-zinc-900 dark:text-white">{t.title}</p>
                <p className="text-xs text-zinc-400 font-bold mt-0.5">
                  {t.recurrence === 'days' ? String(t.days || '').split(',').filter(Boolean).map((d: string) => DOW[Number(d)]).join(' · ') : (ar ? 'يومياً' : 'Daily')} · {t.due_time || '23:59'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => toggleTemplate(t)} title={t.active ? (ar ? 'إيقاف' : 'Pause') : (ar ? 'تفعيل' : 'Activate')}
                  className={cn("p-1.5 rounded-lg", t.active ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-400")}><Power size={14} /></button>
                <button onClick={() => editTemplate(t)} className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand"><Pencil size={14} /></button>
                <button onClick={() => delTemplate(t)} className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-red-500"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-5">
        <h3 className="font-black text-zinc-900 dark:text-white mb-3 flex items-center gap-2"><Calendar size={18} className="text-brand" />{ar ? 'تقويم الشهر — ما سيُطلق كل يوم' : 'This month — what fires each day'}</h3>
        <div className="grid grid-cols-7 gap-1">
          {DOW.map((d) => <div key={d} className="text-[10px] font-black uppercase tracking-widest text-zinc-400 py-1 text-center">{d}</div>)}
          {Array.from({ length: lead }).map((_, i) => <div key={`pad${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const dow = new Date(now.getFullYear(), now.getMonth(), day).getDay();
            const fires = firesOn(dow);
            const isToday = day === now.getDate();
            return (
              <div key={day} className={cn("min-h-16 rounded-lg border p-1", isToday ? "border-brand bg-brand/5" : "border-zinc-100 dark:border-zinc-800")}>
                <div className={cn("text-[10px] font-black", isToday ? "text-brand" : "text-zinc-400")}>{day}</div>
                <div className="space-y-0.5 mt-0.5">
                  {fires.slice(0, 3).map((t: any) => (
                    <div key={t.id} title={t.title} className={cn("text-[8px] font-black px-1 py-0.5 rounded truncate", t.assign_mode === 'auto' ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30" : "bg-violet-100 text-violet-700 dark:bg-violet-900/30")}>{t.title}</div>
                  ))}
                  {fires.length > 3 && <div className="text-[8px] font-bold text-zinc-400">+{fires.length - 3}</div>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 mt-3 text-[10px] font-black text-zinc-500">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-400" />Auto</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-violet-400" />Pool</span>
        </div>
      </div>
    </div>);
  }

  // tracker
  return (<div>{Toast}
    <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-3">
        <h2 className="font-black text-zinc-900 dark:text-white">{ar ? 'متابعة المهام' : 'Task Tracker'}</h2>
        <button onClick={exportTasks} disabled={allTasks.length === 0}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-brand text-white text-sm font-black disabled:opacity-50 active:scale-95 transition">
          <Download size={15} />{ar ? 'تنزيل Excel' : 'Export Excel'}
        </button>
      </div>
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
                <td className="px-4 py-3"><div className="font-black text-zinc-900 dark:text-white">{t.title || t.task_type || (ar ? 'مهمة' : 'Task')}</div>{t.title && t.task_type && <span className="inline-block text-[10px] font-black px-1.5 py-0.5 rounded text-brand bg-brand/10 my-0.5">{t.task_type}</span>}{t.description && <div className="text-[11px] text-zinc-400 font-medium truncate max-w-xs">{t.description}</div>}<div className="text-[10px] text-zinc-400 font-bold">{ar ? 'من' : 'by'} {t.assigned_by_name}</div></td>
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
            <div><label className={label}>{ar ? 'نوع المهمة' : 'Task Type'}</label><select value={eTaskType} onChange={(e) => setETaskType(e.target.value)} className={field}><option value="">{ar ? '— اختر —' : '— Select —'}</option>{activities.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}</select></div>
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
