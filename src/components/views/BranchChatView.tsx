import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { Send, Paperclip, X, MessageSquare, Download, Search, Plus, Camera, Reply, CheckCheck, Check, Clock3 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useFetch } from '../../hooks/useFetch';
import { useWebSocket } from '../../hooks/useWebSocket';

interface ChatMessage {
  id: number;
  branch_id: number;
  sender_id: number;
  sender_role: string;
  comment: string | null;
  image_url: string | null;
  image_type: string | null;
  status: string | null;
  status_at: string | null;
  status_by_name: string | null;
  created_at: string;
  username: string;
  reply_to_id: number | null;
  reply_username: string | null;
  reply_comment: string | null;
  reply_has_image: boolean;
  reply_sender_role: string | null;
  answered: boolean;
  resolved_at: string | null;
  resolve_reason: string | null;
  resolved_by_name: string | null;
}
interface Thread {
  branch_id: number;
  brand_name: string;
  branch_name: string;
  last_at: string;
  unread: number;
  last_comment: string | null;
  last_has_image: boolean;
  last_sender_role: string | null;
}

// Human-readable role labels for chat bubbles / Excel export. Falls back to the
// raw role_name for any role not listed. The stored sender_role is unchanged;
// this only affects display (previously every non-Restaurant role showed "Tech").
const ROLE_LABELS: Record<string, { ar: string; en: string }> = {
  'Restaurants': { ar: 'مطعم', en: 'Restaurant' },
  'Call Center': { ar: 'كول سنتر', en: 'Call Center' },
  'Technical Back Office': { ar: 'باك أوفيس', en: 'Back Office' },
  'Technical Team': { ar: 'تكنيكال', en: 'Tech' },
  'Manager': { ar: 'مدير', en: 'Manager' },
  'Super Visor': { ar: 'مشرف', en: 'Supervisor' },
  'Operation Manager': { ar: 'مدير عمليات', en: 'Operation Manager' },
  'Area Manager': { ar: 'مدير منطقة', en: 'Area Manager' },
  'Marketing Team': { ar: 'ماركتنج', en: 'Marketing' },
  'Coding Team': { ar: 'كودينج', en: 'Coding' },
};
const roleLabel = (role: string | null | undefined, lang: string) => {
  if (!role) return lang === 'ar' ? 'تكنيكال' : 'Tech';
  const entry = ROLE_LABELS[role];
  return entry ? (lang === 'ar' ? entry.ar : entry.en) : role;
};

export default function BranchChatView() {
  const { user, lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const lastMessage = useWebSocket();
  const isRestaurant = user?.role_name === 'Restaurants';
  const isManager = ['Manager', 'Super Visor', 'Operation Manager'].includes(user?.role_name || '');
  const [exporting, setExporting] = useState(false);
  const [brandFilter, setBrandFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [allBranches, setAllBranches] = useState<any[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newBrand, setNewBrand] = useState('all');
  const [newSearch, setNewSearch] = useState('');

  const [threads, setThreads] = useState<Thread[]>([]);
  const [branchId, setBranchId] = useState<number | null>(isRestaurant ? (user?.branch_id ?? null) : null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [comment, setComment] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Jump to (and briefly flash) the original message a quote points at.
  const jumpTo = (id: number) => {
    const el = document.getElementById(`bchat-msg-${id}`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashId(id);
      setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1300);
    }
  };
  const previewText = (comment: string | null, hasImage: boolean) =>
    comment || (hasImage ? (lang === 'ar' ? '📷 صورة' : '📷 Photo') : '');

  // Swipe-to-reply (mobile): drag a bubble sideways to reply to it.
  const swipe = useRef<{ x: number; y: number; el: HTMLElement; active: boolean; mine: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent, mine: boolean) => {
    const t = e.touches[0];
    swipe.current = { x: t.clientX, y: t.clientY, el: e.currentTarget as HTMLElement, active: false, mine };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current; if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (!s.active) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) s.active = true;
      else if (Math.abs(dy) > 10) { swipe.current = null; return; }
      else return;
    }
    let d = s.mine ? Math.min(0, dx) : Math.max(0, dx);
    d = Math.max(-80, Math.min(80, d));
    s.el.style.transform = `translateX(${d}px)`;
  };
  const onTouchEnd = (e: React.TouchEvent, m: ChatMessage) => {
    const s = swipe.current; if (!s) return;
    const dx = (e.changedTouches[0]?.clientX ?? s.x) - s.x;
    const el = s.el;
    el.style.transition = 'transform 150ms';
    el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; }, 170);
    if (s.mine ? dx <= -55 : dx >= 55) setReplyTo(m);
    swipe.current = null;
  };

  const fetchThreads = async () => {
    if (isRestaurant) return;
    try {
      const res = await fetchWithAuth(`${API_URL}/branch-chat/threads`);
      if (res.ok) setThreads(await res.json());
    } catch (e) { /* ignore */ }
  };

  const fetchMessages = async (bid: number | null) => {
    if (!bid) { setMessages([]); return; }
    try {
      const res = await fetchWithAuth(`${API_URL}/branch-chat?branch_id=${bid}`);
      if (res.ok) setMessages(await res.json());
    } catch (e) { /* ignore */ }
  };

  const fetchBranches = async () => {
    if (isRestaurant) return;
    try {
      const res = await fetchWithAuth(`${API_URL}/branches`);
      if (res.ok) setAllBranches(await res.json());
    } catch (e) { /* ignore */ }
  };

  useEffect(() => { fetchThreads(); fetchBranches(); }, []);
  useEffect(() => { fetchMessages(branchId); }, [branchId]);

  // Office can start a chat with any branch (even one that never messaged).
  const startChat = (bid: number) => {
    setBranchId(bid);
    setShowNew(false);
    setNewSearch('');
  };

  // Auto-open a specific branch when navigated here from a ticket / notification.
  useEffect(() => {
    if (isRestaurant) return;
    const pick = (bid: any) => { const n = Number(bid); if (n) setBranchId(n); };
    const stored = sessionStorage.getItem('open_chat_branch');
    if (stored) { pick(stored); sessionStorage.removeItem('open_chat_branch'); }
    const handler = (e: any) => { if (e?.detail) pick(e.detail); };
    window.addEventListener('open-branch-chat', handler);
    return () => window.removeEventListener('open-branch-chat', handler);
  }, []);

  // Live updates
  useEffect(() => {
    if (lastMessage?.type === 'BRANCH_CHAT_UPDATED') {
      if (!isRestaurant) fetchThreads();
      // A restaurant only has one thread, so always refresh it. Office refreshes
      // the open thread when it matches (number-safe comparison).
      if (branchId != null && (isRestaurant || Number(lastMessage.branch_id) === Number(branchId))) {
        fetchMessages(branchId);
      }
    }
  }, [lastMessage]);

  // Always land on the latest message (also after images load and grow the list).
  const scrollToBottom = () => endRef.current?.scrollIntoView({ block: 'end' });
  useEffect(() => { scrollToBottom(); }, [messages, branchId]);

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setImage(f); const r = new FileReader(); r.onloadend = () => setImagePreview(r.result as string); r.readAsDataURL(f); }
    e.target.value = '';
  };

  const send = async () => {
    if (!branchId || (!comment.trim() && !image) || sending) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append('branch_id', String(branchId));
      if (comment.trim()) fd.append('comment', comment.trim());
      if (image) fd.append('image', image);
      if (replyTo) fd.append('reply_to_id', String(replyTo.id));
      const res = await fetchWithAuth(`${API_URL}/branch-chat`, { method: 'POST', body: fd });
      if (res.ok) {
        setComment(''); setImage(null); setImagePreview(null); setReplyTo(null);
        await fetchMessages(branchId);
        if (!isRestaurant) fetchThreads();
      }
    } catch (e) { /* ignore */ } finally { setSending(false); }
  };

  // Manager-only: download the full chat log (who sent, when, reply, response time).
  const exportExcel = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/branch-chat/export`);
      if (!res.ok) return;
      const rows: any[] = await res.json();
      const data = rows.map((r) => ({
        Brand: r.brand_name,
        Branch: r.branch_name,
        'Sent At': formatDate(r.created_at),
        'Sender': r.username,
        'Role': roleLabel(r.sender_role, 'en'),
        'Message': r.comment || '',
        'Image': r.has_image ? 'Yes' : 'No',
        'Status': r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : 'Pending',
        'Replied To': r.replied_to || '',
        'Response Time (min)': r.response_minutes ?? '',
      }));
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 40 }, { wch: 8 }, { wch: 10 }, { wch: 16 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Invoice Chat');
      XLSX.writeFile(wb, `Invoice_Chat_Log_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) { /* ignore */ } finally { setExporting(false); }
  };

  const ChatPane = (
    <div className="flex flex-col flex-1 min-h-0 bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      {!branchId ? (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <MessageSquare size={40} />
          <p className="font-bold uppercase tracking-widest text-xs">{lang === 'ar' ? 'اختر فرعًا للمحادثة' : 'Select a branch to chat'}</p>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && (
              <p className="text-center text-zinc-400 text-xs font-bold uppercase tracking-widest mt-10">
                {lang === 'ar' ? 'لا توجد رسائل بعد' : 'No messages yet'}
              </p>
            )}
            {messages.map((m) => {
              const mine = m.sender_id === user?.id;
              const replyBtn = (
                <button onClick={() => setReplyTo(m)} title={lang === 'ar' ? 'رد' : 'Reply'}
                  className="shrink-0 self-center p-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand hover:bg-brand/10 transition">
                  <Reply size={18} />
                </button>
              );
              return (
                <div key={m.id} className={cn("group flex items-center gap-1", mine ? "justify-end" : "justify-start")}>
                  {mine && replyBtn}
                  <div
                    id={`bchat-msg-${m.id}`}
                    onTouchStart={(e) => onTouchStart(e, mine)}
                    onTouchMove={onTouchMove}
                    onTouchEnd={(e) => onTouchEnd(e, m)}
                    className={cn(
                      "max-w-[78%] rounded-2xl p-3 shadow-sm",
                      mine ? "bg-brand text-white" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white",
                      flashId === m.id && "ring-2 ring-brand ring-offset-2 ring-offset-white dark:ring-offset-zinc-900"
                    )}>
                    <div className={cn("text-[10px] font-black uppercase tracking-widest mb-1 opacity-70")}>
                      {m.username} · {roleLabel(m.sender_role, lang)}
                    </div>

                    {m.reply_to_id && (
                      <button onClick={() => jumpTo(m.reply_to_id!)}
                        className={cn(
                          "w-full text-left flex gap-2 rounded-lg overflow-hidden mb-1.5",
                          mine ? "bg-white/15 hover:bg-white/25" : "bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20"
                        )}>
                        <div className={cn("w-1 shrink-0", mine ? "bg-white/70" : "bg-brand")} />
                        <div className="min-w-0 py-1 pr-2">
                          <div className={cn("text-[10px] font-black truncate", mine ? "text-white/90" : "text-brand")}>
                            {m.reply_username || (lang === 'ar' ? 'رسالة' : 'message')}
                          </div>
                          <div className={cn("text-[11px] truncate", mine ? "text-white/80" : "text-zinc-500 dark:text-zinc-400")}>
                            {previewText(m.reply_comment, m.reply_has_image)}
                          </div>
                        </div>
                      </button>
                    )}

                    {m.image_url && (
                      <img
                        src={m.image_url}
                        alt="invoice"
                        className="rounded-xl max-w-full max-h-72 object-cover cursor-zoom-in mb-1.5"
                        onClick={() => window.open(m.image_url!, '_blank')}
                        onLoad={scrollToBottom}
                      />
                    )}
                    {m.comment && <p className="text-sm font-medium whitespace-pre-wrap break-words">{m.comment}</p>}

                    {m.sender_role === 'Restaurants' && (() => {
                      const onMine = mine; // restaurant viewing own (green) bubble
                      // A deliberate Dismiss wins over an auto "replied" (a later
                      // office message to another message shouldn't mark this replied).
                      if (m.resolved_at) {
                        return (
                          <div className={cn("mt-1.5 inline-flex items-center gap-1 text-[10px] font-black",
                            onMine ? "text-white/80" : "text-zinc-500 dark:text-zinc-400")}
                            title={m.resolve_reason ? `${lang === 'ar' ? 'السبب' : 'Reason'}: ${m.resolve_reason}` : undefined}>
                            <Check size={13} /> {lang === 'ar' ? 'تم بدون رد' : 'Dismissed'}
                            {m.resolved_by_name ? ` · ${m.resolved_by_name}` : ''}
                          </div>
                        );
                      }
                      if (m.answered) {
                        return (
                          <div className={cn("mt-1.5 inline-flex items-center gap-1 text-[10px] font-black",
                            onMine ? "text-white/90" : "text-emerald-600 dark:text-emerald-400")}>
                            <CheckCheck size={13} /> {lang === 'ar' ? 'تم الرد' : 'Replied'}
                          </div>
                        );
                      }
                      return (
                        <div className={cn("mt-1.5 inline-flex items-center gap-1 text-[10px] font-black",
                          onMine ? "text-white/90" : "text-amber-600 dark:text-amber-400")}>
                          <Clock3 size={13} /> {lang === 'ar' ? 'بانتظار الرد' : 'Awaiting reply'}
                        </div>
                      );
                    })()}

                    <div className={cn("text-[9px] font-bold mt-1 opacity-60", mine ? "text-right" : "text-left")}>
                      {formatDate(m.created_at)}
                    </div>
                  </div>
                  {!mine && replyBtn}
                </div>
              );
            })}
            <div ref={endRef} />
          </div>

          {/* Composer */}
          <div className="border-t border-zinc-100 dark:border-zinc-800 p-3">
            {replyTo && (
              <div className="flex items-center gap-2 mb-2 bg-zinc-50 dark:bg-zinc-800/50 rounded-xl overflow-hidden">
                <div className="w-1 self-stretch bg-brand shrink-0" />
                <div className="min-w-0 flex-1 py-1.5">
                  <div className="text-xs font-black text-brand truncate">
                    {lang === 'ar' ? 'ترد على' : 'Replying to'} {replyTo.username}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {previewText(replyTo.comment, !!replyTo.image_url)}
                  </div>
                </div>
                <button onClick={() => setReplyTo(null)} className="shrink-0 p-2 text-zinc-400 hover:text-red-500" title={lang === 'ar' ? 'إلغاء' : 'Cancel'}>
                  <X size={16} />
                </button>
              </div>
            )}
            {imagePreview && (
              <div className="relative w-20 h-20 mb-2 rounded-xl overflow-hidden border-2 border-brand/20">
                <img src={imagePreview} alt="preview" className="w-full h-full object-cover" />
                <button onClick={() => { setImage(null); setImagePreview(null); }} className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full">
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <label className="shrink-0 cursor-pointer p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand" title={lang === 'ar' ? 'الكاميرا' : 'Camera'}>
                <Camera size={20} />
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={pickFile} />
              </label>
              <label className="shrink-0 cursor-pointer p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand" title={lang === 'ar' ? 'إرفاق صورة' : 'Attach image'}>
                <Paperclip size={20} />
                <input type="file" accept="image/*" className="hidden" onChange={pickFile} />
              </label>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                placeholder={lang === 'ar' ? 'اكتب تعليقًا...' : 'Write a comment...'}
                className="flex-1 min-w-0 px-4 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none text-sm font-medium text-zinc-900 dark:text-white"
              />
              <button onClick={send} disabled={sending || (!comment.trim() && !image)} className="shrink-0 p-2.5 rounded-xl bg-brand text-white disabled:opacity-50">
                <Send size={20} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );

  const brandList = Array.from(new Set(threads.map((t) => t.brand_name))).sort();
  const totalUnread = threads.reduce((s, t) => s + (t.unread || 0), 0);
  const shortTime = (d: string) => new Date(d).toLocaleString(lang === 'ar' ? 'ar' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const visibleThreads = threads
    .filter((t) => brandFilter === 'all' || t.brand_name === brandFilter)
    .filter((t) => !unreadOnly || t.unread > 0)
    .filter((t) => {
      const q = search.trim().toLowerCase();
      return !q || t.branch_name.toLowerCase().includes(q) || t.brand_name.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const ua = a.unread > 0 ? 1 : 0, ub = b.unread > 0 ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return new Date(b.last_at).getTime() - new Date(a.last_at).getTime();
    });

  // New-chat picker: every branch the office can reach.
  const newBrandList = Array.from(new Set(allBranches.map((b) => b.brand_name))).sort();
  const newBranches = allBranches
    .filter((b) => newBrand === 'all' || b.brand_name === newBrand)
    .filter((b) => {
      const q = newSearch.trim().toLowerCase();
      return !q || (b.name || '').toLowerCase().includes(q) || (b.brand_name || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div className="w-full max-w-[1200px] mx-auto flex flex-col gap-4 flex-1 min-h-0">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <MessageSquare className="text-brand" size={24} />
            <h2 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
              {lang === 'ar' ? 'الشات' : 'Chat'}
            </h2>
          </div>
          <p className="text-zinc-500 font-medium text-sm">
            {lang === 'ar' ? 'تبادل صور الفواتير والتعليقات مع التكنيكال' : 'Share invoice photos and comments with the technical team'}
          </p>
        </div>
        {isManager && (
          <button onClick={exportExcel} disabled={exporting}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-xs font-black uppercase tracking-widest hover:bg-emerald-700 disabled:opacity-50">
            <Download size={16} />
            {exporting ? (lang === 'ar' ? 'جارٍ التصدير...' : 'Exporting...') : (lang === 'ar' ? 'تصدير Excel' : 'Export Excel')}
          </button>
        )}
      </div>

      {isRestaurant ? (
        ChatPane
      ) : (
        <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
          {/* Threads list */}
          <div className="lg:w-80 shrink-0 bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-3 max-h-[40vh] lg:max-h-none lg:h-full overflow-y-auto space-y-2">
            <button onClick={() => setShowNew(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-brand text-white text-xs font-black uppercase tracking-widest hover:opacity-90 transition-all active:scale-95">
              <Plus size={16} />
              {lang === 'ar' ? 'محادثة جديدة' : 'New Chat'}
            </button>
            {/* Filters */}
            <div className="space-y-2 px-1 pt-1">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder={lang === 'ar' ? 'بحث عن فرع...' : 'Search branch...'}
                  className="w-full pl-9 pr-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800 text-sm font-medium outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white" />
              </div>
              <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800 text-sm font-bold outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white">
                <option value="all">{lang === 'ar' ? 'كل البراندات' : 'All Brands'}</option>
                {brandList.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <button onClick={() => setUnreadOnly((v) => !v)}
                className={cn("w-full px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all",
                  unreadOnly ? "bg-brand text-white" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand")}>
                {lang === 'ar' ? 'غير المقروء فقط' : 'Unread only'}{totalUnread > 0 ? ` · ${totalUnread}` : ''}
              </button>
            </div>

            {visibleThreads.length === 0 && <p className="px-3 py-6 text-center text-zinc-400 text-xs font-bold">{lang === 'ar' ? 'لا محادثات' : 'No chats'}</p>}
            {visibleThreads.map((t) => {
              const preview = t.last_comment || (t.last_has_image ? (lang === 'ar' ? '📷 صورة' : '📷 Photo') : '');
              return (
                <button
                  key={t.branch_id}
                  onClick={() => setBranchId(t.branch_id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-2xl transition-all flex items-start gap-2",
                    branchId === t.branch_id ? "bg-brand/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-black text-zinc-900 dark:text-white truncate">{t.branch_name}</p>
                      <span className="shrink-0 text-[9px] font-bold text-zinc-400">{shortTime(t.last_at)}</span>
                    </div>
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-tight truncate">{t.brand_name}</p>
                    {preview && (
                      <p className={cn("text-xs truncate mt-0.5",
                        t.unread > 0 ? "text-zinc-700 dark:text-zinc-200 font-bold" : "text-zinc-400 font-medium")}>
                        {t.last_sender_role && t.last_sender_role !== 'Restaurants' ? (lang === 'ar' ? 'أنت: ' : 'You: ') : ''}{preview}
                      </p>
                    )}
                  </div>
                  {t.unread > 0 && (
                    <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-brand text-white text-[10px] font-black flex items-center justify-center mt-0.5">{t.unread}</span>
                  )}
                </button>
              );
            })}
          </div>
          {ChatPane}
        </div>
      )}

      {/* New-chat picker (office): choose a brand + branch to start a thread */}
      {showNew && !isRestaurant && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-zinc-900/70 backdrop-blur-sm" onClick={() => setShowNew(false)} />
          <div className="relative bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-md border border-zinc-200 dark:border-zinc-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-black text-zinc-900 dark:text-white">{lang === 'ar' ? 'محادثة جديدة' : 'New Chat'}</h3>
              <button onClick={() => setShowNew(false)} className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl"><X size={20} /></button>
            </div>
            <select value={newBrand} onChange={(e) => setNewBrand(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 text-sm font-bold outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white">
              <option value="all">{lang === 'ar' ? 'كل البراندات' : 'All Brands'}</option>
              {newBrandList.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input value={newSearch} onChange={(e) => setNewSearch(e.target.value)}
                placeholder={lang === 'ar' ? 'بحث عن فرع...' : 'Search branch...'}
                className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 text-sm font-medium outline-none border-2 border-transparent focus:border-brand text-zinc-900 dark:text-white" />
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1 -mx-1 px-1">
              {newBranches.length === 0 && (
                <p className="px-3 py-6 text-center text-zinc-400 text-xs font-bold">{lang === 'ar' ? 'لا توجد فروع' : 'No branches'}</p>
              )}
              {newBranches.map((b) => (
                <button key={b.id} onClick={() => startChat(b.id)}
                  className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-brand/10 transition-all flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-black text-zinc-900 dark:text-white truncate">{b.name}</p>
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-tight truncate">{b.brand_name}</p>
                  </div>
                  <MessageSquare size={16} className="text-brand shrink-0" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
