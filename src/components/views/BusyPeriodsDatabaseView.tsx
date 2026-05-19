import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate, safeJson } from '../../lib/utils';
import { Search, Filter, Calendar, Clock, Download, Eye, X, Edit2, Check, Loader2, ChevronDown, User, MessageCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { BusyPeriodRecord } from '../../types';
import { useWebSocket } from '../../hooks/useWebSocket';

import { useFetch } from '../../hooks/useFetch';

export default function BusyPeriodsDatabaseView() {
  const { user, lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [records, setRecords] = useState<BusyPeriodRecord[]>([]);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('Busy');
  const [selectedRecord, setSelectedRecord] = useState<BusyPeriodRecord | null>(null);
  const [editingRecord, setEditingRecord] = useState<BusyPeriodRecord | null>(null);
  const [editEndTime, setEditEndTime] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const lastMessage = useWebSocket();

  const handleWhatsApp = (record: BusyPeriodRecord) => {
    const text = `Dear Team,\n\n` +
      `Please be informed that the following branch is currently busy. Kindly do not send any orders to this branch until further notice.\n\n` +
      `Brand: ${record.brand}\n` +
      `Branch: ${record.branch}\n` +
      `Date: ${new Date(record.date).toLocaleDateString()}\n` +
      `Start Time: ${record.start_time}\n` +
      `End Time: ${record.end_time}\n` +
      `Duration: ${record.total_duration}\n` +
      `Reason: ${record.reason_category}\n` +
      `Responsible: ${record.responsible_party}\n` +
      `Comment: ${record.comment || 'N/A'}\n\n` +
      `Further updates will be shared accordingly.\n\n` +
      `Best regards,\n` +
      `${record.username}`;
    
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_URL}/busy-periods`);
      if (!res.ok) {
        const errorData = await safeJson(res);
        throw new Error(`Failed to fetch busy periods: ${res.status} ${errorData?.error || ''}`);
      }
      const data = await safeJson(res);
      const recordsList = Array.isArray(data) ? data : [];
      setRecords(recordsList);
      
      const uniqueBrands = Array.from(new Set(recordsList.map((r: any) => r.brand)));
      if (uniqueBrands.length === 1) {
        setBrandFilter(uniqueBrands[0]);
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch busy periods", err);
      setError(err.message || 'An unexpected error occurred while fetching busy periods.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'BUSY_PERIOD_CREATED' || lastMessage?.type === 'BUSY_PERIOD_UPDATED') {
      fetchData();
    }
  }, [lastMessage]);

  const calculateDuration = (start: string, end: string) => {
    const startDate = new Date(`2000-01-01T${start}`);
    const endDate = new Date(`2000-01-01T${end}`);
    
    let diff = (endDate.getTime() - startDate.getTime()) / 1000 / 60; // in minutes
    if (diff < 0) diff += 24 * 60; // handle overnight
    
    const hours = Math.floor(diff / 60);
    const minutes = diff % 60;
    return {
      formatted: `${hours}h ${minutes}m`,
      minutes: diff
    };
  };

  const handleOpen = async (record: BusyPeriodRecord) => {
    setUpdating(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/busy-periods/${record.id}`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          action: 'OPEN'
        })
      });
      
      if (res.ok) {
        const data = await safeJson(res);
        if (data.pending) {
          alert(lang === 'en' ? 'Open request sent for approval' : 'تم إرسال طلب الفتح للموافقة');
        } else {
          fetchData();
        }
      } else {
        const errorData = await safeJson(res);
        alert(lang === 'ar' ? (errorData?.error || 'فشل في فتح الفرع') : (errorData?.error_en || errorData?.error || 'Failed to open branch'));
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to open branch", err);
    } finally {
      setUpdating(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingRecord) return;
    setUpdating(true);
    
    const { formatted, minutes } = calculateDuration(editingRecord.start_time, editEndTime);
    
    try {
      const res = await fetchWithAuth(`${API_URL}/busy-periods/${editingRecord.id}`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          end_time: editEndTime,
          total_duration: formatted,
          total_duration_minutes: minutes
        })
      });
      
      if (res.ok) {
        setEditingRecord(null);
        fetchData();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to update record", err);
    } finally {
      setUpdating(false);
    }
  };

  const handleExport = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/busy-periods/export`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
        a.download = `busy_periods_${dateStr}.xlsx`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (err) {
      console.error("Failed to export data", err);
    }
  };

  const filteredRecords = records.filter(r => {
    const matchesSearch = r.branch.toLowerCase().includes(search.toLowerCase()) || 
                         r.brand.toLowerCase().includes(search.toLowerCase()) ||
                         r.reason_category.toLowerCase().includes(search.toLowerCase());
    const matchesBrand = brandFilter === '' || r.brand === brandFilter;
    const matchesStatus = !statusFilter || (statusFilter === 'Busy' ? !r.end_time : !!r.end_time);
    return matchesSearch && matchesBrand && matchesStatus;
  });

  const brands = Array.isArray(records) ? Array.from(new Set(records.map(r => r.brand))) : [];

  const t = {
    en: {
      title: "History",
      search: "Search branch, brand or reason...",
      brand: "Brand",
      allBrands: "All Brands",
      date: "Date",
      branch: "Branch",
      duration: "Duration",
      reason: "Reason",
      responsible: "Responsible",
      status: "Status",
      startTime: "Start Time",
      endTime: "End Time",
      open: "Open",
      details: "Details",
      all: "All",
      busy: "Busy",
      openStatus: "Open",
      noRecords: "No records found",
      loading: "Loading records...",
      edit: "Edit End Time",
      update: "Update",
      cancel: "Cancel"
    },
    ar: {
      title: "السجل",
      search: "البحث عن الفرع، العلامة التجارية أو السبب...",
      brand: "العلامة التجارية",
      allBrands: "جميع العلامات التجارية",
      date: "التاريخ",
      branch: "الفرع",
      duration: "المدة",
      reason: "السبب",
      responsible: "المسؤول",
      status: "الحالة",
      startTime: "وقت البداية",
      endTime: "وقت النهاية",
      open: "فتح",
      details: "التفاصيل",
      all: "الكل",
      busy: "مشغول",
      openStatus: "مفتوح",
      noRecords: "لم يتم العثور على سجلات",
      loading: "جاري تحميل السجلات...",
      edit: "تعديل وقت الانتهاء",
      update: "تحديث",
      cancel: "إلغاء"
    }
  }[lang];

  return (
    <div className="w-full space-y-8">
      {/* Header & Stats Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h2 className="text-4xl font-black text-zinc-900 dark:text-white tracking-tight mb-2">{t.title}</h2>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium">Monitoring and managing branch performance metrics.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="px-6 py-3 bg-zinc-900 dark:bg-white rounded-2xl text-white dark:text-zinc-900 shadow-xl shadow-zinc-900/20 dark:shadow-white/5 flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-bold">{records.length} Total Records</span>
          </div>
          <button 
            onClick={handleExport}
            className="p-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors shadow-sm"
            title="Export to Excel"
          >
            <Download size={20} />
          </button>
        </div>
      </div>

      {/* Filters & Search Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
        <div className="lg:col-span-12 flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-600 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={20} />
            <input
              type="text"
              placeholder={t.search}
              className="w-full pl-12 pr-4 py-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[1.5rem] outline-none focus:ring-4 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white transition-all font-medium shadow-sm text-zinc-900 dark:text-white"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          
          <div className="flex items-center gap-2 p-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-[1.5rem] shadow-inner">
            {['All', 'Busy', 'Open'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status === 'All' ? '' : status)}
                className={cn(
                  "px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all",
                  (status === 'All' ? !statusFilter : statusFilter === status)
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-lg shadow-zinc-900/5"
                    : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {status === 'All' ? t.all : status === 'Busy' ? t.busy : t.openStatus}
              </button>
            ))}
          </div>

          <div className="w-full md:w-64 relative">
            <Filter className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-600" size={18} />
            <select
              className="w-full pl-11 pr-8 py-4 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[1.5rem] outline-none focus:ring-4 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white transition-all font-bold text-zinc-900 dark:text-white appearance-none shadow-sm"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
            >
              <option value="" className="dark:bg-zinc-900">{t.allBrands}</option>
              {Array.isArray(brands) && brands.map(b => <option key={b} value={b} className="dark:bg-zinc-900">{b}</option>)}
            </select>
            <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-600 pointer-events-none" size={16} />
          </div>
        </div>
      </div>

      {/* Data Table Section */}
      <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50/50 dark:bg-zinc-800/50 border-b border-zinc-100 dark:border-zinc-800">
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.date}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.brand}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.branch}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.startTime}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.endTime}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.duration}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.reason}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{t.status}</th>
                <th className="px-8 py-6 text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em] text-right">{t.details}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-8 py-20 text-center">
                    <div className="flex flex-col items-center gap-4">
                      <Loader2 className="w-10 h-10 text-zinc-900 dark:text-white animate-spin" />
                      <p className="text-zinc-500 dark:text-zinc-400 font-bold tracking-tight">{t.loading}</p>
                    </div>
                  </td>
                </tr>
              ) : filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-8 py-20 text-center">
                    <div className="flex flex-col items-center gap-4 opacity-30 dark:text-white">
                      <Search size={48} />
                      <p className="text-xl font-black">{t.noRecords}</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredRecords.map((record) => (
                  <motion.tr 
                    layout
                    key={record.id} 
                    className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/50 transition-colors group"
                  >
                    <td className="px-8 py-6">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 group-hover:bg-zinc-900 dark:group-hover:bg-white group-hover:text-white dark:group-hover:text-zinc-900 transition-all">
                          <Calendar size={18} />
                        </div>
                        <span className="font-bold text-zinc-900 dark:text-white">{new Date(record.date).toLocaleDateString()}</span>
                      </div>
                    </td>
                    <td className="px-8 py-6">
                      <span className="px-3 py-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg text-xs font-black text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">
                        {record.brand}
                      </span>
                    </td>
                    <td className="px-8 py-6 font-bold text-zinc-900 dark:text-white">{record.branch}</td>
                    <td className="px-8 py-6">
                      <div className="flex items-center gap-2 text-zinc-900 dark:text-white font-black">
                        <Clock size={16} className="text-zinc-400 dark:text-zinc-600" />
                        {record.start_time || "-"}
                      </div>
                    </td>
                    <td className="px-8 py-6">
                      <div className="flex items-center gap-2 text-zinc-900 dark:text-white font-black">
                        <Clock size={16} className="text-zinc-400 dark:text-zinc-600" />
                        {record.end_time || "-"}
                      </div>
                    </td>
                    <td className="px-8 py-6">
                      <div className="flex items-center gap-2 text-zinc-900 dark:text-white font-black">
                        <Clock size={16} className="text-zinc-400 dark:text-zinc-600" />
                        {record.total_duration || "-"}
                      </div>
                    </td>
                    <td className="px-8 py-6">
                      <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{record.reason_category}</span>
                    </td>
                    <td className="px-8 py-6">
                      {!record.end_time ? (
                        <span className="px-3 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-lg text-[10px] font-black uppercase tracking-wider animate-pulse">
                          Busy
                        </span>
                      ) : (
                        <span className="px-3 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-lg text-[10px] font-black uppercase tracking-wider">
                          Open
                        </span>
                      )}
                    </td>
                    <td className="px-8 py-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {!record.end_time && user?.role_name !== 'Call Center' && (user?.role_name !== 'Restaurants' || record.branch === (user as any).branch_name) && (
                          <button
                            onClick={() => handleOpen(record)}
                            disabled={updating}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black transition-all shadow-lg shadow-emerald-600/20 flex items-center gap-2 disabled:opacity-50"
                          >
                            {updating ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                            {t.open}
                          </button>
                        )}
                        <button
                          onClick={() => handleWhatsApp(record)}
                          className="p-2.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-xl transition-all"
                          title="Share via WhatsApp"
                        >
                          <MessageCircle size={18} />
                        </button>
                        {user?.role_name !== 'Call Center' && user?.role_name !== 'Restaurants' && (
                          <button
                            onClick={() => {
                              setEditingRecord(record);
                              setEditEndTime(record.end_time);
                            }}
                            className="p-2.5 text-zinc-400 dark:text-zinc-600 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-all"
                            title={t.edit}
                          >
                            <Edit2 size={18} />
                          </button>
                        )}
                        <button
                          onClick={() => setSelectedRecord(record)}
                          className="p-2.5 text-zinc-400 dark:text-zinc-600 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-all"
                        >
                          <Eye size={18} />
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Modal */}
      <AnimatePresence>
        {selectedRecord && (
          <div className="fixed inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center z-[150] p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white dark:bg-zinc-900 rounded-[3rem] w-full max-w-2xl overflow-hidden shadow-[0_40px_80px_-15px_rgba(0,0,0,0.3)] border border-transparent dark:border-zinc-800"
            >
              <div className="bg-zinc-900 dark:bg-black p-10 text-white relative overflow-hidden">
                <div className="relative z-10 flex items-center justify-between">
                  <div>
                    <h3 className="text-3xl font-black tracking-tight mb-2">Record Details</h3>
                    <p className="text-zinc-400 dark:text-zinc-500 font-medium">{selectedRecord.brand} — {selectedRecord.branch}</p>
                  </div>
                  <button onClick={() => setSelectedRecord(null)} className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl transition-colors">
                    <X size={24} />
                  </button>
                </div>
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
              </div>

              <div className="p-10 space-y-10">
                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Start Time</p>
                    <p className="text-xl font-bold text-zinc-900 dark:text-white">{selectedRecord.start_time}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">End Time</p>
                    <p className="text-xl font-bold text-zinc-900 dark:text-white">{selectedRecord.end_time}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Total Duration</p>
                    <p className="text-xl font-black text-zinc-900 dark:text-white px-4 py-2 bg-zinc-100 dark:bg-zinc-800 rounded-xl inline-block">{selectedRecord.total_duration}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Responsible</p>
                    <p className="text-xl font-bold text-zinc-900 dark:text-white">{selectedRecord.responsible_party}</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="p-6 bg-zinc-50 dark:bg-zinc-800/50 rounded-3xl border border-zinc-100 dark:border-zinc-800">
                    <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">Comment</p>
                    <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed font-medium italic">"{selectedRecord.comment || 'No comment provided'}"</p>
                  </div>
                  {selectedRecord.internal_notes && user?.role_name !== 'Call Center' && (
                    <div className="p-6 bg-amber-50 dark:bg-amber-500/10 rounded-3xl border border-amber-100 dark:border-amber-500/20">
                      <p className="text-[10px] font-black text-amber-600/60 uppercase tracking-widest mb-3">Internal Notes</p>
                      <p className="text-amber-900 dark:text-amber-200 leading-relaxed font-medium">{selectedRecord.internal_notes}</p>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-6 border-t border-zinc-100 dark:border-zinc-800">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-600">
                      <User size={18} />
                    </div>
                    <div>
                      <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Recorded By</p>
                      <p className="text-sm font-bold text-zinc-900 dark:text-white">{selectedRecord.username}</p>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-400 dark:text-zinc-600 font-medium">
                    {formatDate(selectedRecord.created_at)}
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Edit Modal */}
      <AnimatePresence>
        {editingRecord && (
          <div className="fixed inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center z-[150] p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white dark:bg-zinc-900 rounded-[3rem] w-full max-w-md overflow-hidden shadow-[0_40px_80px_-15px_rgba(0,0,0,0.3)] border border-transparent dark:border-zinc-800"
            >
              <div className="p-10 space-y-8">
                <div className="flex items-center justify-between">
                  <h3 className="text-2xl font-black tracking-tight text-zinc-900 dark:text-white">{t.edit}</h3>
                  <button onClick={() => setEditingRecord(null)} className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors text-zinc-500 dark:text-zinc-400">
                    <X size={20} />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="p-6 bg-zinc-50 dark:bg-zinc-800/50 rounded-3xl border border-zinc-100 dark:border-zinc-800 space-y-4">
                    <div className="flex justify-between text-sm">
                      <span className="text-zinc-500 dark:text-zinc-400 font-medium">Start Time</span>
                      <span className="font-bold text-zinc-900 dark:text-white">{editingRecord.start_time}</span>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">New End Time</label>
                      <input
                        type="time"
                        className="w-full px-5 py-4 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 focus:border-zinc-900 dark:focus:border-white focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 outline-none transition-all font-black text-zinc-900 dark:text-white text-xl"
                        value={editEndTime}
                        onChange={(e) => setEditEndTime(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setEditingRecord(null)}
                    className="flex-1 px-6 py-4 rounded-2xl font-bold text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all"
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={handleUpdate}
                    disabled={updating}
                    className="flex-[2] bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-6 py-4 rounded-2xl font-black shadow-xl shadow-zinc-900/20 dark:shadow-white/10 hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all flex items-center justify-center gap-2 disabled:opacity-70"
                  >
                    {updating ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check size={20} className="text-amber-400 dark:text-amber-600" />}
                    {t.update}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
