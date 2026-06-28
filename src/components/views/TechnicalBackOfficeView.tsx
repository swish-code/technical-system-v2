import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate, safeJson } from '../../lib/utils';
import { Calendar, Clock, AlertCircle, CheckCircle2, Loader2, ChevronDown, Globe, Shield, Settings, MessageSquare, Database, User } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import { useFetch } from '../../hooks/useFetch';
import BusyPeriodsDatabaseView from './BusyPeriodsDatabaseView';
import LateOrdersView from './LateOrdersView';

export default function TechnicalBackOfficeView() {
  const { lang, user } = useAuth();
  const { fetchWithAuth } = useFetch();

  if (!user || !['Technical Back Office', 'Manager', 'Super Visor', 'Restaurants', 'Call Center', 'Area Manager', 'Operation Manager'].includes(user.role_name)) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-zinc-500 font-bold">{lang === 'en' ? 'Access Denied' : 'غير مسموح بالدخول'}</p>
      </div>
    );
  }

  const [activeTab, setActiveTab] = useState<'busy' | 'database' | 'technical'>(user?.role_name === 'Call Center' ? 'database' : 'busy');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  
  const [brands, setBrands] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [reasons, setReasons] = useState<any[]>([]);
  const [responsibleParties, setResponsibleParties] = useState<any[]>([]);
  const [isAutoFilling, setIsAutoFilling] = useState(false);

  const [formData, setFormData] = useState({
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' }),
    brand: '',
    branch: '',
    reason_category: '',
    responsible_party: '',
    comment: '',
    internal_notes: '',
    timer_duration: '0', // 0 means End/Continuous
  });

  useEffect(() => {
    if (activeTab === 'busy') {
      const fetchConfig = async () => {
        try {
          const [brRes, bRes, rRes, respRes] = await Promise.all([
            fetchWithAuth(`${API_URL}/brands`),
            fetchWithAuth(`${API_URL}/branches`),
            fetchWithAuth(`${API_URL}/busy-reasons`),
            fetchWithAuth(`${API_URL}/busy-responsible`)
          ]);
          const brData = await safeJson(brRes);
          const bData = await safeJson(bRes);
          const rData = await safeJson(rRes);
          const respData = await safeJson(respRes);

          const brList = Array.isArray(brData) ? brData : [];
          let bList = Array.isArray(bData) ? bData : [];
          const rList = Array.isArray(rData) ? rData : [];
          const respList = Array.isArray(respData) ? respData : [];

          // Filter for Restaurants role
          if (user?.role_name === 'Restaurants' && user.branch_id) {
            bList = bList.filter((b: any) => b.id === user.branch_id);
          }

          setBrands(brList);
          setBranches(bList);
          setReasons(rList);
          setResponsibleParties(respList);

          setFormData(prev => {
            const next = { ...prev };
            if (brList.length === 1) {
              next.brand = brList[0].name;
              const brandBranches = bList.filter((b: any) => b.brand_name === brList[0].name);
              if (brandBranches.length === 1) {
                next.branch = brandBranches[0].name;
              }
            }
            if (rList.length === 1) {
              next.reason_category = rList[0].name;
            }
            if (respList.length === 1) {
              next.responsible_party = respList[0].name;
            }
            return next;
          });
        } catch (err: any) {
          if (err.isAuthError) return;
          console.error("Failed to fetch config", err);
        }
      };
      fetchConfig();
    }
  }, [activeTab]);

  useEffect(() => {
    if (formData.brand && branches.length > 0) {
      const brandBranches = branches.filter(b => b.brand_name === formData.brand);
      if (brandBranches.length === 1) {
        setFormData(prev => ({ ...prev, branch: brandBranches[0].name }));
      }
    }
  }, [formData.brand, branches]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const res = await fetchWithAuth(`${API_URL}/busy-periods`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData)
      });
      
      if (res.ok) {
        showToast(lang === 'en' ? 'Record created successfully' : 'تم إنشاء السجل بنجاح');
        setFormData({
          date: new Date().toISOString().split('T')[0],
          brand: '',
          branch: '',
          reason_category: '',
          responsible_party: '',
          comment: '',
          internal_notes: '',
          timer_duration: '0',
        });
      } else {
        const errorData = await safeJson(res);
        throw new Error(lang === 'ar' ? (errorData?.error || 'فشل في إنشاء السجل') : (errorData?.error_en || errorData?.error || 'Failed to create record'));
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAutoFill = async () => {
    if (user?.role_name !== 'Restaurants') return;
    setIsAutoFilling(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/busy-periods/most-frequent`);
      const data = await safeJson(res);
      if (data.reason_category || data.responsible_party) {
        setFormData(prev => ({
          ...prev,
          reason_category: data.reason_category || prev.reason_category,
          responsible_party: data.responsible_party || prev.responsible_party
        }));
        showToast(lang === 'en' ? 'Form auto-filled with most frequent data' : 'تم تعبئة الحقول تلقائياً بأكثر البيانات تكراراً');
      } else {
        showToast(lang === 'en' ? 'No frequent data found for this branch' : 'لم يتم العثور على بيانات متكررة لهذا الفرع', 'error');
      }
    } catch (err) {
      console.error("Auto-fill error", err);
    } finally {
      setIsAutoFilling(false);
    }
  };

  const t = {
    en: {
      title: "Busy Branch Record",
      date: "Date",
      brand: "Select Brand",
      branch: "Branch",
      startTime: "Start Time",
      endTime: "End Time",
      duration: "Total Busy Duration",
      reason: "Reason Category",
      responsible: "Responsible Party",
      comment: "Comment",
      internalNotes: "Internal Notes",
      submit: "Create Record",
      selectBrand: "Select a brand first",
      busyTab: "Busy Periods",
      databaseTab: "History",
      technicalTab: "Technical Cases",
    },
    ar: {
      title: "سجل فرع مزدحم",
      date: "التاريخ",
      brand: "اختر العلامة التجارية",
      branch: "الفرع",
      startTime: "وقت البدء",
      endTime: "وقت الانتهاء",
      duration: "إجمالي مدة الازدحام",
      reason: "فئة السبب",
      responsible: "الجهة المسؤولة",
      comment: "تعليق",
      internalNotes: "ملاحظات داخلية",
      submit: "إنشاء سجل",
      selectBrand: "اختر علامة تجارية أولاً",
      busyTab: "فترات الازدحام",
      databaseTab: "السجل",
      technicalTab: "الحالات التقنية",
    }
  }[lang];

  const renderTabSwitcher = () => (
    <div className="flex items-center gap-4 bg-white dark:bg-zinc-900 p-2 rounded-2xl border border-zinc-100 dark:border-zinc-800 w-full sm:w-fit self-center overflow-x-auto no-scrollbar">
      <div className="flex items-center gap-4 min-w-max">
        {user?.role_name !== 'Call Center' && (
          <button
            onClick={() => setActiveTab('busy')}
            className={cn(
              "px-6 py-2.5 rounded-xl font-black text-sm transition-all flex items-center gap-2 whitespace-nowrap",
              activeTab === 'busy' 
                ? "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow-lg" 
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
            )}
          >
            <AlertCircle size={18} />
            {t.busyTab}
          </button>
        )}
        {(   user?.role_name === 'Manager' ||   user?.role_name === 'Super Visor' ||   user?.role_name === 'Technical Back Office' ||   user?.role_name === 'Call Center' ||   user?.role_name === 'Restaurants' ||   user?.role_name === 'Operation Manager' ||   user?.role_name === 'Area Manager' ) && (
          <button
            onClick={() => setActiveTab('database')}
            className={cn(
              "px-6 py-2.5 rounded-xl font-black text-sm transition-all flex items-center gap-2 whitespace-nowrap",
              activeTab === 'database' 
                ? "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow-lg" 
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
            )}
          >
            <Database size={18} />
            {t.databaseTab}
          </button>
        )}
        {(user?.role_name === 'Manager' || user?.role_name === 'Super Visor' || user?.role_name === 'Technical Back Office') && (
          <button
            onClick={() => setActiveTab('technical')}
            className={cn(
              "px-6 py-2.5 rounded-xl font-black text-sm transition-all flex items-center gap-2 whitespace-nowrap",
              activeTab === 'technical' 
                ? "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow-lg" 
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
            )}
          >
            <MessageSquare size={18} />
            {t.technicalTab}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6 pb-20 lg:pb-0">
      {renderTabSwitcher()}

      {activeTab === 'technical' ? (
        <LateOrdersView />
      ) : activeTab === 'database' ? (
        <BusyPeriodsDatabaseView />
      ) : (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex-1 bg-white dark:bg-zinc-900 rounded-[2rem] lg:rounded-[2.5rem] shadow-[0_40px_80px_-15px_rgba(0,0,0,0.1)] border border-zinc-100 dark:border-zinc-800 flex flex-col lg:flex-row min-h-fit lg:min-h-[600px]"
        >
        {/* Left Side - Immersive Branding & Info */}
        <div className="lg:w-[380px] bg-zinc-900 dark:bg-black p-8 lg:p-10 text-white flex flex-col justify-between relative overflow-hidden shrink-0 rounded-t-[2rem] lg:rounded-t-none lg:rounded-l-[2.5rem]">
          <div className="relative z-10">
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center mb-10 backdrop-blur-2xl border border-white/10"
            >
              <AlertCircle className="text-amber-400" size={28} />
            </motion.div>
            <h2 className="text-4xl font-black tracking-tight mb-6 leading-[1.1] font-display">
              {t.title}
            </h2>
            <p className="text-zinc-400 text-lg leading-relaxed font-medium">
              {lang === 'en' 
                ? "Streamline branch operations by recording and analyzing high-traffic periods in real-time."
                : "قم بتبسيط عمليات الفروع من خلال تسجيل وتحليل فترات الازدحام العالي في الوقت الفعلي."}
            </p>
          </div>

          <div className="relative z-10 mt-12 space-y-8">
            <div className="flex items-center gap-5 group">
              <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center border border-white/5 group-hover:bg-white/10 transition-all duration-300">
                <Clock className="text-zinc-500 group-hover:text-white transition-colors" size={20} />
              </div>
              <div>
                <p className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1">System Status</p>
                <p className="text-sm font-bold text-zinc-300 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Live Recording Active
                </p>
              </div>
            </div>
            <div className="flex items-center gap-5 group">
              <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center border border-white/5 group-hover:bg-white/10 transition-all duration-300">
                <Calendar className="text-zinc-500 group-hover:text-white transition-colors" size={20} />
              </div>
              <div>
                <p className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1">Session Date</p>
                <p className="text-sm font-bold text-zinc-300">{new Date().toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kuwait' })}</p>
              </div>
            </div>
          </div>

          {/* Abstract Decorative Elements */}
          <div className="absolute -top-24 -right-24 w-64 h-64 bg-amber-500/10 rounded-full blur-[100px]" />
          <div className="absolute -bottom-32 -left-32 w-80 h-80 bg-blue-500/10 rounded-full blur-[120px]" />
          <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:20px_20px]" />
        </div>

        {/* Right Side - Elegant Form */}
        <div className={cn("flex-1 p-8 lg:p-12 bg-white dark:bg-zinc-900 relative", user?.role_name === 'Area Manager' && "hidden")}>
          {user?.role_name === 'Restaurants' && (
            <button
              type="button"
              onClick={handleAutoFill}
              disabled={isAutoFilling}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-amber-500/20 transition-all mb-8 disabled:opacity-50"
            >
              {isAutoFilling ? <Loader2 size={14} className="animate-spin" /> : <Settings size={14} />}
              {lang === 'en' ? 'Auto-fill Most Frequent' : 'تعبئة تلقائية (الأكثر تكراراً)'}
            </button>
          )}
          <form onSubmit={handleSubmit} className="w-full space-y-10">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
              {/* Date Field */}
              <div className="space-y-3">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">{t.date}</label>
                <div className="relative group">
                  <Calendar className="absolute left-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={20} />
                  <input
                    type="date"
                    required
                    className="w-full pl-9 pr-4 py-3 bg-transparent border-b-2 border-zinc-100 dark:border-zinc-800 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white text-lg"
                    value={formData.date}
                    onChange={e => setFormData({ ...formData, date: e.target.value })}
                  />
                </div>
              </div>

              {/* Brand Field */}
              <div className="space-y-3">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">{t.brand}</label>
                <div className="relative group">
                  <Globe className="absolute left-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={20} />
                  <select
                    required
                    className="w-full pl-9 pr-8 py-3 bg-transparent border-b-2 border-zinc-100 dark:border-zinc-800 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white text-lg appearance-none cursor-pointer"
                    value={formData.brand}
                    onChange={e => setFormData({ ...formData, brand: e.target.value, branch: '' })}
                  >
                    <option value="" className="dark:bg-zinc-900">Select Brand</option>
                    {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.name} className="dark:bg-zinc-900">{b.name}</option>)}
                  </select>
                  <ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 pointer-events-none" size={18} />
                </div>
              </div>

              {/* Branch Field */}
              <div className="space-y-3">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">{t.branch}</label>
                <div className="relative group">
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 border-zinc-200 dark:border-zinc-800 group-focus-within:border-zinc-900 dark:group-focus-within:border-white transition-colors" />
                  <select
                    required
                    disabled={!formData.brand}
                    className="w-full pl-9 pr-8 py-3 bg-transparent border-b-2 border-zinc-100 dark:border-zinc-800 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white text-lg appearance-none cursor-pointer disabled:opacity-30"
                    value={formData.branch}
                    onChange={e => setFormData({ ...formData, branch: e.target.value })}
                  >
                    <option value="" className="dark:bg-zinc-900">{formData.brand ? 'Select Branch' : t.selectBrand}</option>
                    {branches.filter(b => b.brand_name === formData.brand).map(b => (
                      <option key={b.id} value={b.name} className="dark:bg-zinc-900">{b.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 pointer-events-none" size={18} />
                </div>
              </div>

              {/* Reason Field */}
              <div className="space-y-3">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">{t.reason}</label>
                <div className="relative group">
                  <Shield className="absolute left-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={20} />
                  <select
                    required
                    className="w-full pl-9 pr-8 py-3 bg-transparent border-b-2 border-zinc-100 dark:border-zinc-800 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white text-lg appearance-none cursor-pointer"
                    value={formData.reason_category}
                    onChange={e => setFormData({ ...formData, reason_category: e.target.value })}
                  >
                    <option value="" className="dark:bg-zinc-900">Select Reason</option>
                    {reasons.map(r => <option key={r.id} value={r.name} className="dark:bg-zinc-900">{r.name}</option>)}
                  </select>
                  <ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 pointer-events-none" size={18} />
                </div>
              </div>

              {/* Responsible Field */}
              <div className="space-y-3">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">{t.responsible}</label>
                <div className="relative group">
                  <Settings className="absolute left-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={20} />
                  <select
                    required
                    className="w-full pl-9 pr-8 py-3 bg-transparent border-b-2 border-zinc-100 dark:border-zinc-800 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white text-lg appearance-none cursor-pointer"
                    value={formData.responsible_party}
                    onChange={e => setFormData({ ...formData, responsible_party: e.target.value })}
                  >
                    <option value="" className="dark:bg-zinc-900">Select Party</option>
                    {responsibleParties.map(p => <option key={p.id} value={p.name} className="dark:bg-zinc-900">{p.name}</option>)}
                  </select>
                  <ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 text-zinc-300 dark:text-zinc-700 pointer-events-none" size={18} />
                </div>
              </div>

              {/* Time Selection (New) */}
              <div className="space-y-3 md:col-span-2">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">
                  {lang === 'en' ? 'Requested Duration' : 'المدة المطلوبة'}
                </label>
                <div className="flex gap-4">
                  {[
                    { label: '15 Min', labelAr: '15 دقيقة', value: '15' },
                    { label: '30 Min', labelAr: '30 دقيقة', value: '30' },
                    { label: 'End', labelAr: 'نهاية', value: '0' }
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormData({ ...formData, timer_duration: opt.value })}
                      className={cn(
                        "flex-1 py-4 rounded-2xl font-black text-sm uppercase tracking-widest transition-all border-2",
                        formData.timer_duration === opt.value
                          ? "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-zinc-900 dark:border-white shadow-lg"
                          : "bg-transparent text-zinc-400 dark:text-zinc-500 border-zinc-100 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600"
                      )}
                    >
                      {lang === 'en' ? opt.label : opt.labelAr}
                    </button>
                  ))}
                </div>
              </div>

              {/* Comment Field */}
              <div className="space-y-3">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">{t.comment}</label>
                <textarea
                  rows={2}
                  placeholder="Describe the situation..."
                  className="w-full px-6 py-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border-2 border-transparent focus:bg-white dark:focus:bg-zinc-800 focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white text-lg resize-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
                  value={formData.comment}
                  onChange={e => setFormData({ ...formData, comment: e.target.value })}
                />
              </div>

              {/* Internal Notes Field */}
              <div className="space-y-3">
                <label className="text-[11px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.25em] ml-1">{t.internalNotes}</label>
                <textarea
                  rows={2}
                  placeholder="For internal use only..."
                  className="w-full px-6 py-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border-2 border-transparent focus:bg-white dark:focus:bg-zinc-800 focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white text-lg resize-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
                  value={formData.internal_notes}
                  onChange={e => setFormData({ ...formData, internal_notes: e.target.value })}
                />
              </div>
            </div>

            <div className="pt-6">
              <motion.button
                whileHover={{ scale: 1.01, y: -2 }}
                whileTap={{ scale: 0.98 }}
                type="submit"
                disabled={loading}
                className="w-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 py-5 rounded-3xl font-black text-xl shadow-[0_20px_40px_-10px_rgba(0,0,0,0.3)] dark:shadow-white/10 hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all flex items-center justify-center gap-4 disabled:opacity-70 disabled:translate-y-0"
              >
                {loading ? (
                  <Loader2 className="w-7 h-7 animate-spin" />
                ) : (
                  <>
                    <CheckCircle2 size={28} className="text-amber-400 dark:text-amber-600" />
                    {user?.role_name === 'Restaurants' ? (lang === 'en' ? 'SUBMIT REQUEST' : 'إرسال طلب') : (lang === 'en' ? 'Record Busy Branch' : 'تسجيل الفرع المزدحم')}
                  </>
                )}
              </motion.button>
            </div>
          </form>
        </div>
      </motion.div>
      )}

      {/* Enhanced Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className={cn(
              "fixed bottom-10 left-1/2 -translate-x-1/2 z-[200] px-10 py-5 rounded-[2rem] shadow-[0_30px_60px_-15px_rgba(0,0,0,0.2)] flex items-center gap-4 font-black text-white backdrop-blur-xl",
              toast.type === 'success' ? "bg-zinc-900/95" : "bg-red-600/95"
            )}
          >
            <div className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center",
              toast.type === 'success' ? "bg-emerald-500/20 text-emerald-400" : "bg-white/20 text-white"
            )}>
              {toast.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            </div>
            <span className="text-lg tracking-tight">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
