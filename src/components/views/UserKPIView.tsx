import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { 
  Clock, 
  Filter, 
  Users,
  Plus,
  RefreshCw,
  Trash2,
  EyeOff,
  Eye,
  Zap,
  Activity,
  FileText
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';

interface UserKpi {
  user_id: number;
  username: string;
  action: string;
  target_table: string;
  count: number;
}

interface UserActivityDetail {
  id: number;
  username: string;
  action: string;
  target_table: string;
  target_id: number;
  old_value: string;
  new_value: string;
  timestamp: string;
}

import { useFetch } from '../../hooks/useFetch';

export default function UserKPIView() {
  const { user, lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [userKpi, setUserKpi] = useState<UserKpi[]>([]);
  const [userActivityDetails, setUserActivityDetails] = useState<UserActivityDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('all');

  const fetchData = async () => {
    setLoading(true);

    try {
      const [kpiRes, detailsRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/reports/user-kpi?period=${period}`),
        fetchWithAuth(`${API_URL}/reports/user-activity-details?period=${period}`)
      ]);

      if (kpiRes.ok) setUserKpi(await kpiRes.json());
      if (detailsRes.ok) setUserActivityDetails(await detailsRes.json());
    } catch (error: any) {
      if (error.isAuthError) return;
      console.error("Error fetching user KPI:", error);
    } finally {
      setLoading(false);
    }
  };

  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();
    
    // KPI Summary Sheet
    const kpiData = userKpi.map(k => ({
      [lang === 'ar' ? 'المستخدم' : 'User']: k.username,
      [lang === 'ar' ? 'الإجراء' : 'Action']: k.action,
      [lang === 'ar' ? 'الجدول المستهدف' : 'Target Table']: k.target_table,
      [lang === 'ar' ? 'العدد' : 'Count']: k.count
    }));
    const kpiWS = XLSX.utils.json_to_sheet(kpiData);
    XLSX.utils.book_append_sheet(wb, kpiWS, lang === 'ar' ? 'ملخص الأداء' : "KPI Summary");

    // Activity Details Sheet
    const activityData = userActivityDetails.map(log => {
      let detailsText = log.target_table;
      try {
        const details = log.new_value ? JSON.parse(log.new_value) : log.old_value ? JSON.parse(log.old_value) : null;
        if (details) {
          if (log.action === 'HIDE' || log.action === 'UNHIDE') {
            detailsText = `${details.product_name} (${details.brand_name || 'Unknown Brand'}) - ${details.branches || details.branch || 'All'}`;
          } else if (log.target_table === 'busy_period_records') {
            detailsText = `${details.brand} - ${details.branch} (${details.reason_category})`;
          } else if (log.target_table === 'products') {
            detailsText = `${details.product_name || `ID: ${log.target_id}`} (${details.brand_name || ''})`;
          } else {
            detailsText = JSON.stringify(details);
          }
        }
      } catch (e) {}

      return {
        [lang === 'ar' ? 'الوقت' : 'Time']: formatDate(log.timestamp),
        [lang === 'ar' ? 'المستخدم' : 'User']: log.username,
        [lang === 'ar' ? 'الإجراء' : 'Action']: log.action,
        [lang === 'ar' ? 'الجدول' : 'Table']: log.target_table,
        [lang === 'ar' ? 'التفاصيل' : 'Details']: detailsText
      };
    });
    const activityWS = XLSX.utils.json_to_sheet(activityData);
    XLSX.utils.book_append_sheet(wb, activityWS, lang === 'ar' ? 'تفاصيل النشاط' : "Activity Details");

    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
    XLSX.writeFile(wb, `Swish_User_KPI_${dateStr}.xlsx`);
  };

  useEffect(() => {
    fetchData();
  }, [period]);

  const renderActionDetails = (log: UserActivityDetail) => {
    try {
      const details = log.new_value ? JSON.parse(log.new_value) : log.old_value ? JSON.parse(log.old_value) : null;
      if (!details) return log.target_table;

      if (log.action === 'HIDE' || log.action === 'UNHIDE') {
        return (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black bg-zinc-900 text-white px-1.5 py-0.5 rounded uppercase tracking-tighter">
                {details.brand_name || 'Unknown Brand'}
              </span>
              <p className="font-black text-zinc-900 dark:text-white">{details.product_name}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {(details.branches || details.branch) && (
                <span className="px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded text-[9px] font-bold text-zinc-500 uppercase tracking-tighter">
                  {details.branches || details.branch}
                </span>
              )}
              {details.reason && (
                <span className="px-2 py-0.5 bg-brand/10 rounded text-[9px] font-bold text-brand uppercase tracking-tighter">
                  {details.reason}
                </span>
              )}
            </div>
          </div>
        );
      }

      if (log.target_table === 'busy_period_records') {
        return (
          <div className="space-y-1">
            <p className="font-black text-zinc-900 dark:text-white">{details.brand} - {details.branch}</p>
            <p className="text-[10px] text-zinc-500 font-bold uppercase">{details.reason_category} ({details.total_duration})</p>
          </div>
        );
      }

      if (log.target_table === 'products') {
        return (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {details.brand_name && (
                <span className="text-[10px] font-black bg-zinc-900 text-white px-1.5 py-0.5 rounded uppercase tracking-tighter">
                  {details.brand_name}
                </span>
              )}
              <p className="font-black text-zinc-900 dark:text-white">{details.product_name || `Product ID: ${log.target_id}`}</p>
            </div>
          </div>
        );
      }

      return <span className="text-zinc-500 text-xs font-medium">{JSON.stringify(details).substring(0, 50)}...</span>;
    } catch (e) {
      return log.target_table;
    }
  };

  return (
    <div className="space-y-10 pb-20">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-2xl bg-brand/10 flex items-center justify-center text-brand">
              <Activity size={24} />
            </div>
            <span className="text-xs font-black text-brand uppercase tracking-[0.3em]">Personal Performance</span>
          </div>
          <h2 className="text-5xl font-display font-black text-zinc-900 dark:text-white tracking-tighter">
            My <span className="text-brand">KPI</span>
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium mt-2">
            {lang === 'ar' ? 'تتبع أدائك الشخصي ونشاطك في النظام' : 'Track your personal performance and system activity'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-zinc-900 p-3 rounded-[2rem] border border-zinc-100 dark:border-zinc-800 shadow-xl shadow-zinc-900/5">
          <button 
            onClick={exportToExcel}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl font-bold text-sm hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20 active:scale-95"
          >
            <FileText size={16} />
            {lang === 'ar' ? 'تحميل إكسيل' : 'Download Excel'}
          </button>
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
            <Filter size={16} className="text-zinc-400" />
            <select 
              className="bg-transparent border-none outline-none text-xs font-black text-zinc-900 dark:text-white uppercase tracking-wider"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="all">{lang === 'ar' ? 'كل المدة' : 'All Time'}</option>
              <option value="today">{lang === 'ar' ? 'اليوم' : 'Today'}</option>
              <option value="week">{lang === 'ar' ? 'هذا الأسبوع' : 'This Week'}</option>
              <option value="month">{lang === 'ar' ? 'هذا الشهر' : 'This Month'}</option>
            </select>
          </div>
          <button 
            onClick={fetchData}
            disabled={loading}
            className="w-12 h-12 flex items-center justify-center bg-brand text-white rounded-xl hover:bg-brand/90 transition-all shadow-lg shadow-brand/20 disabled:opacity-50"
          >
            <RefreshCw size={20} className={cn(loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-card p-10 rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6 mb-10">
          {['CREATE', 'UPDATE', 'DELETE', 'HIDE', 'UNHIDE', 'BUSY'].map((action) => {
            const count = userKpi
              .filter(k => k.action === action || (action === 'BUSY' && k.action === 'BUSY_UPDATE'))
              .reduce((acc, curr) => acc + curr.count, 0);
            
            const icon = action === 'CREATE' ? Plus : 
                        action === 'UPDATE' ? RefreshCw : 
                        action === 'DELETE' ? Trash2 : 
                        action === 'HIDE' ? EyeOff : 
                        action === 'UNHIDE' ? Eye : 
                        Zap;
            const color = action === 'CREATE' ? 'emerald' : 
                         action === 'UPDATE' ? 'indigo' : 
                         action === 'DELETE' ? 'red' : 
                         action === 'HIDE' ? 'amber' : 
                         action === 'UNHIDE' ? 'emerald' : 
                         'brand';

            const Icon = icon;

            return (
              <div key={action} className="bg-zinc-50 dark:bg-zinc-800/50 p-6 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                <div className="flex items-center justify-between mb-4">
                  <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", 
                    action === 'BUSY' ? "bg-brand/10 text-brand" : `bg-${color}/10 text-${color}`)}>
                    <Icon size={20} />
                  </div>
                  <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{action}</span>
                </div>
                <h5 className="text-3xl font-display font-black text-zinc-900 dark:text-white">{count}</h5>
              </div>
            );
          })}
        </div>

        <div className="overflow-hidden rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900/50">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/50">
                <th className="px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Time (Kuwait)</th>
                <th className="px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Action</th>
                <th className="px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
              {userActivityDetails.length > 0 ? userActivityDetails.map((log, i) => (
                <tr key={i} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-all group">
                  <td className="px-10 py-6">
                    <div className="flex items-center gap-3">
                      <Clock size={14} className="text-zinc-400" />
                      <span className="text-xs font-black text-zinc-900 dark:text-white tabular-nums">
                        {formatDate(log.timestamp)}
                      </span>
                    </div>
                  </td>
                  <td className="px-10 py-6">
                    <span className={cn(
                      "px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest",
                      log.action === 'CREATE' || log.action === 'UNHIDE' ? "bg-emerald-50 text-emerald-600" :
                      log.action === 'UPDATE' ? "bg-indigo-50 text-indigo-600" :
                      log.action === 'DELETE' ? "bg-red-50 text-red-600" :
                      log.action === 'BUSY' || log.action === 'BUSY_UPDATE' ? "bg-brand/10 text-brand" :
                      "bg-amber-50 text-amber-600"
                    )}>
                      {log.action.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-10 py-6">
                    {renderActionDetails(log)}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={3} className="px-10 py-12 text-center text-zinc-400 font-bold uppercase tracking-widest text-xs">
                    No activity found for the selected filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
