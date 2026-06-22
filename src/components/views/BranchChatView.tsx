import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { Send, Paperclip, X, MessageSquare, CheckCircle2, XCircle } from 'lucide-react';
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
}
interface Thread {
  branch_id: number;
  brand_name: string;
  branch_name: string;
  last_at: string;
  unread: number;
}

export default function BranchChatView() {
  const { user, lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const lastMessage = useWebSocket();
  const isRestaurant = user?.role_name === 'Restaurants';

  const [threads, setThreads] = useState<Thread[]>([]);
  const [branchId, setBranchId] = useState<number | null>(isRestaurant ? (user?.branch_id ?? null) : null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [comment, setComment] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => { fetchThreads(); }, []);
  useEffect(() => { fetchMessages(branchId); }, [branchId]);

  // Live updates
  useEffect(() => {
    if (lastMessage?.type === 'BRANCH_CHAT_UPDATED') {
      if (!isRestaurant) fetchThreads();
      if (lastMessage.branch_id === branchId) fetchMessages(branchId);
    }
  }, [lastMessage]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async () => {
    if (!branchId || (!comment.trim() && !image) || sending) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append('branch_id', String(branchId));
      if (comment.trim()) fd.append('comment', comment.trim());
      if (image) fd.append('image', image);
      const res = await fetchWithAuth(`${API_URL}/branch-chat`, { method: 'POST', body: fd });
      if (res.ok) {
        setComment(''); setImage(null); setImagePreview(null);
        await fetchMessages(branchId);
        if (!isRestaurant) fetchThreads();
      }
    } catch (e) { /* ignore */ } finally { setSending(false); }
  };

  // Recipient approves / rejects a message.
  const act = async (id: number, status: 'approved' | 'rejected') => {
    try {
      const res = await fetchWithAuth(`${API_URL}/branch-chat/${id}/status`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) await fetchMessages(branchId);
    } catch (e) { /* ignore */ }
  };

  const ChatPane = (
    <div className="flex flex-col flex-1 min-h-[60vh] bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      {!branchId ? (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <MessageSquare size={40} />
          <p className="font-bold uppercase tracking-widest text-xs">{lang === 'ar' ? 'اختر فرعًا للمحادثة' : 'Select a branch to chat'}</p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && (
              <p className="text-center text-zinc-400 text-xs font-bold uppercase tracking-widest mt-10">
                {lang === 'ar' ? 'لا توجد رسائل بعد' : 'No messages yet'}
              </p>
            )}
            {messages.map((m) => {
              const mine = m.sender_id === user?.id;
              return (
                <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                  <div className={cn(
                    "max-w-[78%] rounded-2xl p-3 shadow-sm",
                    mine ? "bg-brand text-white" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white"
                  )}>
                    <div className={cn("text-[10px] font-black uppercase tracking-widest mb-1 opacity-70")}>
                      {m.username} · {m.sender_role === 'Restaurants' ? (lang === 'ar' ? 'مطعم' : 'Restaurant') : (lang === 'ar' ? 'تكنيكال' : 'Tech')}
                    </div>
                    {m.image_url && (
                      <img
                        src={m.image_url}
                        alt="invoice"
                        className="rounded-xl max-w-full max-h-72 object-cover cursor-zoom-in mb-1.5"
                        onClick={() => window.open(m.image_url!, '_blank')}
                      />
                    )}
                    {m.comment && <p className="text-sm font-medium whitespace-pre-wrap break-words">{m.comment}</p>}

                    {/* Approve / Reject — shown to the recipient (opposite side) while pending */}
                    {(() => {
                      const canAct = isRestaurant ? m.sender_role !== 'Restaurants' : m.sender_role === 'Restaurants';
                      const decided = m.status === 'approved' || m.status === 'rejected';
                      if (decided) {
                        return (
                          <div className={cn(
                            "mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest",
                            m.status === 'approved' ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-red-500/15 text-red-500"
                          )}>
                            {m.status === 'approved' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                            {m.status === 'approved' ? (lang === 'ar' ? 'تمت الموافقة' : 'Approved') : (lang === 'ar' ? 'مرفوض' : 'Rejected')}
                            {m.status_by_name ? ` · ${m.status_by_name}` : ''}
                          </div>
                        );
                      }
                      if (canAct) {
                        return (
                          <div className="mt-2 flex items-center gap-2">
                            <button onClick={() => act(m.id, 'approved')} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600">
                              <CheckCircle2 size={12} /> {lang === 'ar' ? 'موافقة' : 'Approve'}
                            </button>
                            <button onClick={() => act(m.id, 'rejected')} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-500 text-white text-[10px] font-black uppercase tracking-widest hover:bg-red-600">
                              <XCircle size={12} /> {lang === 'ar' ? 'رفض' : 'Reject'}
                            </button>
                          </div>
                        );
                      }
                      return null;
                    })()}

                    <div className={cn("text-[9px] font-bold mt-1 opacity-60", mine ? "text-right" : "text-left")}>
                      {formatDate(m.created_at)}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>

          {/* Composer */}
          <div className="border-t border-zinc-100 dark:border-zinc-800 p-3">
            {imagePreview && (
              <div className="relative w-20 h-20 mb-2 rounded-xl overflow-hidden border-2 border-brand/20">
                <img src={imagePreview} alt="preview" className="w-full h-full object-cover" />
                <button onClick={() => { setImage(null); setImagePreview(null); }} className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full">
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <label className="cursor-pointer p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-brand">
                <Paperclip size={20} />
                <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { setImage(f); const r = new FileReader(); r.onloadend = () => setImagePreview(r.result as string); r.readAsDataURL(f); }
                  e.target.value = '';
                }} />
              </label>
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                placeholder={lang === 'ar' ? 'اكتب تعليقًا...' : 'Write a comment...'}
                className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none text-sm font-medium text-zinc-900 dark:text-white"
              />
              <button onClick={send} disabled={sending || (!comment.trim() && !image)} className="p-2.5 rounded-xl bg-brand text-white disabled:opacity-50">
                <Send size={20} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MessageSquare className="text-brand" size={24} />
          <h2 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
            {lang === 'ar' ? 'مراسلات الفواتير' : 'Invoice Chat'}
          </h2>
        </div>
        <p className="text-zinc-500 font-medium text-sm">
          {lang === 'ar' ? 'تبادل صور الفواتير والتعليقات مع التكنيكال' : 'Share invoice photos and comments with the technical team'}
        </p>
      </div>

      {isRestaurant ? (
        ChatPane
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Threads list */}
          <div className="lg:w-72 shrink-0 bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-3 max-h-[70vh] overflow-y-auto">
            <p className="px-3 py-2 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'الفروع' : 'Branches'}</p>
            {threads.length === 0 && <p className="px-3 py-6 text-center text-zinc-400 text-xs font-bold">{lang === 'ar' ? 'لا محادثات' : 'No chats'}</p>}
            {threads.map((t) => (
              <button
                key={t.branch_id}
                onClick={() => setBranchId(t.branch_id)}
                className={cn(
                  "w-full text-left px-3 py-3 rounded-2xl transition-all flex items-center justify-between gap-2",
                  branchId === t.branch_id ? "bg-brand/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-black text-zinc-900 dark:text-white truncate">{t.branch_name}</p>
                  <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-tight truncate">{t.brand_name}</p>
                </div>
                {t.unread > 0 && (
                  <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-brand text-white text-[10px] font-black flex items-center justify-center">{t.unread}</span>
                )}
              </button>
            ))}
          </div>
          {ChatPane}
        </div>
      )}
    </div>
  );
}
