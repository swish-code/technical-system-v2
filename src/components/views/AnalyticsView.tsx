import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import * as XLSX from 'xlsx';
import { 
  BarChart3, 
  TrendingUp, 
  Clock, 
  Filter, 
  Calendar, 
  Building2, 
  Package, 
  EyeOff, 
  RefreshCw, 
  PieChart as PieChartIcon, 
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  ShieldCheck,
  AlertTriangle,
  FileText,
  Users,
  Plus,
  Trash2,
  Eye
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Brand } from '../../types';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  PieChart,
  Pie,
  AreaChart,
  Area,
  LineChart,
  Line,
  Legend
} from 'recharts';

interface BrandReport {
  brand_name: string;
  total_products: number;
  hidden_products: number;
}

interface HideReport {
  branch_name: string;
  today_count: number;
  week_count: number;
  month_count: number;
  total_count: number;
}

interface BusyReport {
  branch_name: string;
  total_instances: number;
  total_minutes: number;
  avg_minutes: number;
}

interface ReasonReport {
  name: string;
  value: number;
}

interface TimelineData {
  date: string;
  incidents: number;
  duration: number;
}

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

export default function AnalyticsView() {
  const { user, lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [brandsReport, setBrandsReport] = useState<BrandReport[]>([]);
  const [hidesReport, setHidesReport] = useState<HideReport[]>([]);
  const [busyReport, setBusyReport] = useState<BusyReport[]>([]);
  const [reasonsReport, setReasonsReport] = useState<ReasonReport[]>([]);
  const [timelineData, setTimelineData] = useState<TimelineData[]>([]);
  const [userKpi, setUserKpi] = useState<UserKpi[]>([]);
  const [userActivityDetails, setUserActivityDetails] = useState<UserActivityDetail[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);

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
  const [branches, setBranches] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'hide' | 'busy' | 'kpi'>('general');
  
  const [filters, setFilters] = useState({
    branch: 'all',
    brand: 'all',
    period: 'all', // today, week, month, all
    date: '',
    user: 'all'
  });

  const fetchFilters = async () => {
    try {
      const [bRes, brRes, uRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/brands`),
        fetchWithAuth(`${API_URL}/branches`),
        fetchWithAuth(`${API_URL}/users`)
      ]);
      if (bRes.ok) {
        const data = await bRes.json();
        let brandsList = Array.isArray(data) ? data : [];
        if (user?.role_name === 'Area Manager' && user.brand_id) {
          brandsList = brandsList.filter(b => b.id === user.brand_id);
        }
        setBrands(brandsList);
      }
      if (brRes.ok) {
        const data = await brRes.json();
        let branchesList = Array.isArray(data) ? data : [];
        if (user?.role_name === 'Area Manager' && user.branch_ids) {
          branchesList = branchesList.filter(b => user.branch_ids?.includes(b.id));
        }
        setBranches(branchesList);
      }
      if (uRes.ok) {
        const data = await uRes.json();
        setUsers(Array.isArray(data) ? data : []);
      }
    } catch (error: any) {
      if (error.isAuthError) return;
      console.error("Error fetching filters:", error);
    }
  };

  const fetchData = async () => {
    setLoading(true);

    const queryParams = new URLSearchParams();
    if (filters.branch !== 'all') queryParams.append('branch_id', filters.branch);
    if (filters.brand !== 'all') queryParams.append('brand_id', filters.brand);
    if (filters.period !== 'all') queryParams.append('period', filters.period);
    if (filters.date) queryParams.append('date', filters.date);
    if (filters.user !== 'all') queryParams.append('user_id', filters.user);

    try {
      const [bRes, hRes, busyRes, rRes, tRes, kpiRes, detailsRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/reports/brands?${queryParams.toString()}`),
        fetchWithAuth(`${API_URL}/reports/branch-hides?${queryParams.toString()}`),
        fetchWithAuth(`${API_URL}/reports/branch-busy?${queryParams.toString()}`),
        fetchWithAuth(`${API_URL}/reports/reasons?${queryParams.toString()}`),
        fetchWithAuth(`${API_URL}/reports/timeline`),
        fetchWithAuth(`${API_URL}/reports/user-kpi?${queryParams.toString()}`),
        fetchWithAuth(`${API_URL}/reports/user-activity-details?${queryParams.toString()}`)
      ]);

      if (bRes.ok) {
        const data = await bRes.json();
        const formatted = Array.isArray(data) ? data.map((b: any) => ({
          ...b,
          total_products: Number(b.total_products || 0),
          hidden_products: Number(b.hidden_products || 0)
        })) : [];
        setBrandsReport(formatted);
      }
      if (hRes.ok) {
        const data = await hRes.json();
        const formatted = Array.isArray(data) ? data.map((h: any) => ({
          ...h,
          today_count: Number(h.today_count || 0),
          week_count: Number(h.week_count || 0),
          month_count: Number(h.month_count || 0),
          total_count: Number(h.total_count || 0)
        })) : [];
        setHidesReport(formatted);
      }
      if (busyRes.ok) {
        const data = await busyRes.json();
        const formatted = Array.isArray(data) ? data.map((b: any) => ({
          ...b,
          total_instances: Number(b.total_instances || 0),
          total_minutes: Number(b.total_minutes || 0),
          avg_minutes: Number(b.avg_minutes || 0)
        })) : [];
        setBusyReport(formatted);
      }
      if (rRes.ok) {
        const data = await rRes.json();
        const formatted = Array.isArray(data) ? data.map((r: any) => ({
          ...r,
          value: Number(r.value || 0)
        })) : [];
        setReasonsReport(formatted);
      }
      if (tRes.ok) {
        const data = await tRes.json();
        const formatted = Array.isArray(data) ? data.map((t: any) => ({
          ...t,
          incidents: Number(t.incidents || 0),
          duration: Number(t.duration || 0)
        })) : [];
        setTimelineData(formatted);
      }
      if (kpiRes.ok) {
        const data = await kpiRes.json();
        const formatted = Array.isArray(data) ? data.map((k: any) => ({
          ...k,
          count: Number(k.count || 0)
        })) : [];
        setUserKpi(formatted);
      }
      if (detailsRes.ok) {
        const data = await detailsRes.json();
        setUserActivityDetails(Array.isArray(data) ? data : []);
      }
    } catch (error: any) {
      if (error.isAuthError) return;
      console.error("Error fetching analytics:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFilters();
    fetchData();
  }, []);

  useEffect(() => {
    fetchData();
  }, [filters]);

  const sortedBrands = [...brandsReport].sort((a, b) => b.total_products - a.total_products);
  const sortedHides = [...hidesReport].sort((a, b) => b.total_count - a.total_count);
  const sortedBusy = [...busyReport].sort((a, b) => b.total_minutes - a.total_minutes);

  const peakHoursData = userActivityDetails.reduce((acc: any, log) => {
    try {
      const hour = new Date(log.timestamp).getHours();
      acc[hour] = (acc[hour] || 0) + 1;
    } catch (e) {}
    return acc;
  }, {});

  const peakHoursChartData = Array.from({ length: 24 }, (_, i) => ({
    hour: i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i-12} PM`,
    count: peakHoursData[i] || 0
  }));

  const activityDistribution = userKpi.reduce((acc: any, curr) => {
    const action = curr.action === 'BUSY_UPDATE' ? 'BUSY' : curr.action;
    acc[action] = (acc[action] || 0) + Number(curr.count || 0);
    return acc;
  }, {});

  const activityDistData = Object.entries(activityDistribution).map(([name, value]) => ({
    name,
    value: value as number
  })).sort((a, b) => b.value - a.value);

  const userLeaderboard = Object.values(userKpi.reduce((acc: any, curr) => {
    if (!acc[curr.username]) {
      acc[curr.username] = { username: curr.username, total: 0 };
    }
    acc[curr.username].total += Number(curr.count || 0);
    return acc;
  }, {})).sort((a: any, b: any) => b.total - a.total) as { username: string, total: number }[];

  const COLORS = ['#F27D26', '#10B981', '#6366F1', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4'];

  const handleDownload = () => {
    const wb = XLSX.utils.book_new();
    
    // Summary Sheet
    const summaryData = [
      { Metric: 'Total Products', Value: brandsReport.reduce((acc, b) => acc + Number(b.total_products || 0), 0) },
      { Metric: 'Hidden Items', Value: brandsReport.reduce((acc, b) => acc + Number(b.hidden_products || 0), 0) },
      { Metric: 'Busy Incidents', Value: busyReport.reduce((acc, b) => acc + Number(b.total_instances || 0), 0) },
      { Metric: 'Total Downtime (Minutes)', Value: busyReport.reduce((acc, b) => acc + Number(b.total_minutes || 0), 0) }
    ];
    const summaryWS = XLSX.utils.json_to_sheet(summaryData.map(s => ({
      [lang === 'ar' ? 'المقياس' : 'Metric']: s.Metric,
      [lang === 'ar' ? 'القيمة' : 'Value']: s.Value
    })));
    XLSX.utils.book_append_sheet(wb, summaryWS, lang === 'ar' ? 'ملخص تنفيذي' : "Executive Summary");

    // Timeline Sheet
    const timelineWS = XLSX.utils.json_to_sheet(timelineData.map(t => ({
      [lang === 'ar' ? 'التاريخ' : 'Date']: t.date,
      [lang === 'ar' ? 'الحوادث' : 'Incidents']: t.incidents,
      [lang === 'ar' ? 'المدة (دقيقة)' : 'Duration (Min)']: t.duration
    })));
    XLSX.utils.book_append_sheet(wb, timelineWS, lang === 'ar' ? 'الخط الزمني للحوادث' : "Incident Timeline");
    
    // Brands Sheet
    const brandsWS = XLSX.utils.json_to_sheet(brandsReport.map(b => ({
      [lang === 'ar' ? 'اسم البراند' : 'Brand Name']: b.brand_name,
      [lang === 'ar' ? 'إجمالي المنتجات' : 'Total Products']: b.total_products,
      [lang === 'ar' ? 'المنتجات المخفية' : 'Hidden Products']: b.hidden_products,
      [lang === 'ar' ? 'معدل الظهور' : 'Visibility Rate']: `${Math.round(((b.total_products - b.hidden_products) / b.total_products) * 100)}%`
    })));
    XLSX.utils.book_append_sheet(wb, brandsWS, lang === 'ar' ? 'أداء البراندات' : "Brands Performance");

    // Hides Sheet
    const hidesWS = XLSX.utils.json_to_sheet(hidesReport.map(h => ({
      [lang === 'ar' ? 'اسم الفرع' : 'Branch Name']: h.branch_name,
      [lang === 'ar' ? 'إخفاءات اليوم' : 'Today Hides']: h.today_count,
      [lang === 'ar' ? 'إخفاءات الأسبوع' : 'Weekly Hides']: h.week_count,
      [lang === 'ar' ? 'إخفاءات الشهر' : 'Monthly Hides']: h.month_count,
      [lang === 'ar' ? 'إجمالي الإخفاءات' : 'Total Hides']: h.total_count
    })));
    XLSX.utils.book_append_sheet(wb, hidesWS, lang === 'ar' ? 'ظهور الفروع' : "Branch Visibility");

    // Busy Sheet
    const busyWS = XLSX.utils.json_to_sheet(busyReport.map(b => ({
      [lang === 'ar' ? 'اسم الفرع' : 'Branch Name']: b.branch_name,
      [lang === 'ar' ? 'إجمالي الحوادث' : 'Total Incidents']: b.total_instances,
      [lang === 'ar' ? 'إجمالي الدقائق' : 'Total Minutes']: b.total_minutes,
      [lang === 'ar' ? 'متوسط المدة (دقيقة)' : 'Average Duration (Min)']: Math.round(b.avg_minutes || 0),
      [lang === 'ar' ? 'الحالة' : 'Status']: (b.total_minutes || 0) > 100 ? (lang === 'ar' ? 'حرج' : 'Critical') : (b.total_minutes || 0) > 50 ? (lang === 'ar' ? 'تحذير' : 'Warning') : (lang === 'ar' ? 'مستقر' : 'Stable')
    })));
    XLSX.utils.book_append_sheet(wb, busyWS, lang === 'ar' ? 'الكفاءة التشغيلية' : "Operational Efficiency");

    // Reasons Sheet
    const reasonsWS = XLSX.utils.json_to_sheet(reasonsReport.map(r => ({
      [lang === 'ar' ? 'الفئة' : 'Category']: r.name,
      [lang === 'ar' ? 'العدد' : 'Count']: r.value
    })));
    XLSX.utils.book_append_sheet(wb, reasonsWS, lang === 'ar' ? 'الأسباب الجذرية' : "Root Causes");

    // User KPIs Sheet
    const aggregatedKpis = userKpi.reduce((acc: any, curr) => {
      if (!acc[curr.username]) {
        acc[curr.username] = {
          [lang === 'ar' ? 'المستخدم' : 'User']: curr.username,
          [lang === 'ar' ? 'إجمالي الإجراءات' : 'Total Actions']: 0,
          [lang === 'ar' ? 'إنشاء' : 'Creates']: 0,
          [lang === 'ar' ? 'تحديث' : 'Updates']: 0,
          [lang === 'ar' ? 'حذف' : 'Deletes']: 0,
          [lang === 'ar' ? 'إخفاء' : 'Hides']: 0,
          [lang === 'ar' ? 'إظهار' : 'Unhides']: 0,
          [lang === 'ar' ? 'سجلات مشغول' : 'Busy Records']: 0
        };
      }
      acc[curr.username][lang === 'ar' ? 'إجمالي الإجراءات' : 'Total Actions'] += Number(curr.count || 0);
      if (curr.action === 'CREATE') acc[curr.username][lang === 'ar' ? 'إنشاء' : 'Creates'] += Number(curr.count || 0);
      if (curr.action === 'UPDATE') acc[curr.username][lang === 'ar' ? 'تحديث' : 'Updates'] += Number(curr.count || 0);
      if (curr.action === 'DELETE') acc[curr.username][lang === 'ar' ? 'حذف' : 'Deletes'] += Number(curr.count || 0);
      if (curr.action === 'HIDE') acc[curr.username][lang === 'ar' ? 'إخفاء' : 'Hides'] += Number(curr.count || 0);
      if (curr.action === 'UNHIDE') acc[curr.username][lang === 'ar' ? 'إظهار' : 'Unhides'] += Number(curr.count || 0);
      if (curr.target_table === 'busy_period_records') acc[curr.username][lang === 'ar' ? 'سجلات مشغول' : 'Busy Records'] += Number(curr.count || 0);
      return acc;
    }, {});

    const kpiWS = XLSX.utils.json_to_sheet(Object.values(aggregatedKpis));
    XLSX.utils.book_append_sheet(wb, kpiWS, lang === 'ar' ? 'مؤشرات أداء المستخدمين' : "User KPIs");

    // User Activity Details Sheet
    const activityWS = XLSX.utils.json_to_sheet(userActivityDetails.map(log => ({
      [lang === 'ar' ? 'الوقت (الكويت)' : 'Time (Kuwait)']: formatDate(log.timestamp),
      [lang === 'ar' ? 'المستخدم' : 'User']: log.username,
      [lang === 'ar' ? 'الإجراء' : 'Action']: log.action,
      [lang === 'ar' ? 'الجدول' : 'Table']: log.target_table,
      [lang === 'ar' ? 'التفاصيل' : 'Details']: log.action === 'HIDE' || log.action === 'UNHIDE' 
        ? `${JSON.parse(log.new_value || '{}').product_name || 'Item'} in ${JSON.parse(log.new_value || '{}').branch || 'All Branches'}`
        : log.action === 'BUSY' || log.action === 'BUSY_UPDATE'
        ? `${JSON.parse(log.new_value || '{}').branch || 'Branch'}: ${JSON.parse(log.new_value || '{}').reason || 'Busy'}`
        : `ID: ${log.target_id}`
    })));
    XLSX.utils.book_append_sheet(wb, activityWS, lang === 'ar' ? 'سجلات نشاط المستخدمين' : "User Activity Logs");

    // Peak Hours Sheet
    const peakHoursWS = XLSX.utils.json_to_sheet(peakHoursChartData.map(p => ({
      [lang === 'ar' ? 'الساعة' : 'Hour']: p.hour,
      [lang === 'ar' ? 'عدد النشاطات' : 'Activity Count']: p.count
    })));
    XLSX.utils.book_append_sheet(wb, peakHoursWS, lang === 'ar' ? 'ساعات الذروة' : "Peak Hours");

    // Action Distribution Sheet
    const actionDistWS = XLSX.utils.json_to_sheet(activityDistData.map(a => ({
      [lang === 'ar' ? 'نوع الإجراء' : 'Action Type']: a.name,
      [lang === 'ar' ? 'العدد' : 'Count']: a.value
    })));
    XLSX.utils.book_append_sheet(wb, actionDistWS, lang === 'ar' ? 'توزيع الإجراءات' : "Action Distribution");

    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
    XLSX.writeFile(wb, `Swish_Menu_Full_Analytics_${dateStr}.xlsx`);
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-zinc-100 dark:border-zinc-800 shadow-2xl">
          <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center gap-3 mb-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">{entry.name}:</span>
              <span className="text-xs font-black text-zinc-900 dark:text-white">{entry.value}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-10 pb-20">
      {/* Header & Global Filters */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-2xl bg-brand/10 flex items-center justify-center text-brand">
              <BarChart3 size={24} />
            </div>
            <span className="text-xs font-black text-brand uppercase tracking-[0.3em]">Operational Intelligence</span>
          </div>
          <h2 className="text-3xl md:text-5xl font-display font-black text-zinc-900 dark:text-white tracking-tighter">
            {lang === 'ar' ? 'تحليلات' : 'System'} <span className="text-brand">{lang === 'ar' ? 'النظام' : 'Analytics'}</span>
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium mt-2">
            {lang === 'ar' ? 'مراقبة أداء النظام والفروع في الوقت الفعلي' : 'Real-time monitoring of system and branch operations'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button 
            onClick={handleDownload}
            className="flex items-center gap-2 px-6 py-3 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl border border-zinc-100 dark:border-zinc-800 hover:scale-105 transition-transform"
          >
            <FileText size={16} className="text-brand" />
            {lang === 'ar' ? 'تحميل التقرير الكامل' : 'Download Full Report'}
          </button>

          <div className="flex flex-wrap items-center gap-4 bg-white dark:bg-zinc-900 p-3 rounded-[2rem] border border-zinc-100 dark:border-zinc-800 shadow-xl shadow-zinc-900/5">
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
            <Building2 size={16} className="text-zinc-400" />
            <select 
              className="bg-transparent border-none outline-none text-xs font-black text-zinc-900 dark:text-white uppercase tracking-wider"
              value={filters.brand}
              onChange={(e) => setFilters({...filters, brand: e.target.value})}
            >
              <option value="all">{lang === 'ar' ? 'كل البراندات' : 'All Brands'}</option>
              {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
            <Building2 size={16} className="text-zinc-400" />
            <select 
              className="bg-transparent border-none outline-none text-xs font-black text-zinc-900 dark:text-white uppercase tracking-wider"
              value={filters.branch}
              onChange={(e) => setFilters({...filters, branch: e.target.value})}
            >
              {user?.role_name !== 'Area Manager' && <option value="all">{lang === 'ar' ? 'كل الفروع' : 'All Branches'}</option>}
              {branches.filter(b => filters.brand === 'all' || b.brand_id === parseInt(filters.brand)).map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
            <Filter size={16} className="text-zinc-400" />
            <select 
              className="bg-transparent border-none outline-none text-xs font-black text-zinc-900 dark:text-white uppercase tracking-wider"
              value={filters.period}
              onChange={(e) => setFilters({...filters, period: e.target.value})}
            >
              <option value="all">{lang === 'ar' ? 'كل المدة' : 'All Time'}</option>
              <option value="today">{lang === 'ar' ? 'اليوم' : 'Today'}</option>
              <option value="week">{lang === 'ar' ? 'هذا الأسبوع' : 'This Week'}</option>
              <option value="month">{lang === 'ar' ? 'هذا الشهر' : 'This Month'}</option>
            </select>
          </div>
          
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
            <Users size={16} className="text-zinc-400" />
            <select 
              className="bg-transparent border-none outline-none text-xs font-black text-zinc-900 dark:text-white uppercase tracking-wider"
              value={filters.user}
              onChange={(e) => setFilters({...filters, user: e.target.value})}
            >
              <option value="all">{lang === 'ar' ? 'كل المستخدمين' : 'All Users'}</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
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
    </div>

    {/* Sub-tab Switcher */}
      <div className="flex items-center gap-2 p-1 bg-zinc-100 dark:bg-zinc-800/50 rounded-2xl w-full overflow-x-auto no-scrollbar">
        <button
          onClick={() => setActiveSubTab('general')}
          className={cn(
            "px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all min-w-max",
            activeSubTab === 'general' 
              ? "bg-white dark:bg-zinc-900 text-brand shadow-lg" 
              : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          )}
        >
          {lang === 'ar' ? 'عام' : 'General'}
        </button>
        <button
          onClick={() => setActiveSubTab('hide')}
          className={cn(
            "px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all min-w-max",
            activeSubTab === 'hide' 
              ? "bg-white dark:bg-zinc-900 text-brand shadow-lg" 
              : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          )}
        >
          {lang === 'ar' ? 'إخفاء' : 'Hide'}
        </button>
        <button
          onClick={() => setActiveSubTab('busy')}
          className={cn(
            "px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all min-w-max",
            activeSubTab === 'busy' 
              ? "bg-white dark:bg-zinc-900 text-brand shadow-lg" 
              : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          )}
        >
          {lang === 'ar' ? 'مشغول' : 'Busy'}
        </button>
        <button
          onClick={() => setActiveSubTab('kpi')}
          className={cn(
            "px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all min-w-max",
            activeSubTab === 'kpi' 
              ? "bg-white dark:bg-zinc-900 text-brand shadow-lg" 
              : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          )}
        >
          {lang === 'ar' ? 'مؤشرات الأداء' : 'KPI'}
        </button>
      </div>

      {activeSubTab === 'general' && (
        <div className="space-y-8">
          {/* Stats Overview */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { label: lang === 'ar' ? 'إجمالي المنتجات' : 'Total Products', value: brandsReport.reduce((acc, b) => acc + Number(b.total_products || 0), 0), icon: Package, color: 'brand', trend: '+12%', trendUp: true },
              { label: lang === 'ar' ? 'العناصر المخفية' : 'Hidden Items', value: brandsReport.reduce((acc, b) => acc + Number(b.hidden_products || 0), 0), icon: EyeOff, color: 'red', trend: '-5%', trendUp: false },
              { label: lang === 'ar' ? 'حالات الانشغال' : 'Busy Incidents', value: busyReport.reduce((acc, b) => acc + Number(b.total_instances || 0), 0), icon: Clock, color: 'indigo', trend: '+2%', trendUp: true },
              { label: lang === 'ar' ? 'وقت التوقف' : 'Total Downtime', value: `${busyReport.reduce((acc, b) => acc + Number(b.total_minutes || 0), 0)}m`, icon: Activity, color: 'emerald', trend: '-15%', trendUp: false },
            ].map((stat, i) => (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.1 }}
                key={i}
                className="glass-card p-8 rounded-[2rem] border border-zinc-100 dark:border-zinc-800 group relative overflow-hidden"
              >
                <div className={cn("absolute top-0 right-0 w-24 h-24 blur-[60px] opacity-20 -mr-12 -mt-12 transition-all group-hover:opacity-40", `bg-${stat.color}`)} />
                <div className="flex justify-between items-start mb-6 relative z-10">
                  <div className={cn("w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-transform group-hover:scale-110", 
                    stat.color === 'brand' ? "bg-brand/10 text-brand" : 
                    stat.color === 'red' ? "bg-red-500/10 text-red-500" :
                    stat.color === 'indigo' ? "bg-indigo-500/10 text-indigo-500" :
                    "bg-emerald-500/10 text-emerald-500")}>
                    <stat.icon size={28} />
                  </div>
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-black",
                    stat.trendUp ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
                  )}>
                    {stat.trendUp ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                    {stat.trend}
                  </div>
                </div>
                <p className="text-[10px] font-black text-zinc-400 uppercase tracking-[0.2em] mb-1 relative z-10">{stat.label}</p>
                <h4 className="text-4xl font-display font-black text-zinc-900 dark:text-white relative z-10 tracking-tighter">{stat.value}</h4>
              </motion.div>
            ))}
          </div>

          {/* Timeline Chart */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="lg:col-span-2 glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
            >
              <div className="flex items-center justify-between mb-12">
                <div>
                  <h3 className="text-2xl md:text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                    {lang === 'ar' ? 'الخط الزمني للحوادث' : 'Incident Timeline'}
                  </h3>
                  <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                    {lang === 'ar' ? 'اتجاهات النشاط ووقت التوقف (آخر 30 يومًا)' : 'Activity and downtime trends (Last 30 Days)'}
                  </p>
                </div>
                <div className="hidden md:flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-brand" />
                    <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'الحوادث' : 'Incidents'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-emerald-500" />
                    <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'المدة' : 'Duration'}</span>
                  </div>
                </div>
              </div>

              <div className="h-[300px] md:h-[400px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timelineData}>
                    <defs>
                      <linearGradient id="colorIncidents" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#F27D26" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#F27D26" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorDuration" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10B981" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#10B981" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f1f1" />
                    <XAxis 
                      dataKey="date" 
                      axisLine={false} 
                      tickLine={false} 
                      tick={{ fill: '#9ca3af', fontSize: 10, fontWeight: 900 }}
                      dy={10}
                    />
                    <YAxis 
                      axisLine={false} 
                      tickLine={false} 
                      tick={{ fill: '#9ca3af', fontSize: 10, fontWeight: 900 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="incidents" stroke="#F27D26" strokeWidth={4} fillOpacity={1} fill="url(#colorIncidents)" name={lang === 'ar' ? 'الحوادث' : 'Incidents'} />
                    <Area type="monotone" dataKey="duration" stroke="#10B981" strokeWidth={4} fillOpacity={1} fill="url(#colorDuration)" name={lang === 'ar' ? 'المدة (دقيقة)' : 'Duration (min)'} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1 }}
              className="glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
            >
              <div className="mb-10">
                <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                  {lang === 'ar' ? 'الأسباب الجذرية' : 'Root Causes'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'توزيع فئات الحوادث' : 'Distribution of incident categories'}
                </p>
              </div>

              <div className="h-[250px] md:h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={reasonsReport}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={8}
                      dataKey="value"
                      nameKey="name"
                    >
                      {reasonsReport.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-8 space-y-4">
                {reasonsReport.slice(0, 3).map((r, i) => (
                  <div key={i} className="flex items-center justify-between group">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-full transition-transform group-hover:scale-125" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                      <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">{r.name}</span>
                    </div>
                    <span className="text-xs font-black text-zinc-900 dark:text-white">{r.value}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Peak Hours & Activity Distribution */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="lg:col-span-2 glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
            >
              <div className="mb-10">
                <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                  {lang === 'ar' ? 'ساعات الذروة للنشاط' : 'Peak Activity Hours'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'توزيع النشاط على مدار اليوم' : 'Activity distribution throughout the day'}
                </p>
              </div>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={peakHoursChartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f1f1" />
                    <XAxis 
                      dataKey="hour" 
                      axisLine={false} 
                      tickLine={false} 
                      tick={{ fill: '#9ca3af', fontSize: 9, fontWeight: 900 }}
                    />
                    <YAxis 
                      axisLine={false} 
                      tickLine={false} 
                      tick={{ fill: '#9ca3af', fontSize: 10, fontWeight: 900 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="count" fill="#6366F1" radius={[4, 4, 0, 0]} barSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
            >
              <div className="mb-10">
                <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                  {lang === 'ar' ? 'توزيع الإجراءات' : 'Action Distribution'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'أنواع الإجراءات المتخذة' : 'Types of actions performed'}
                </p>
              </div>
              <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={activityDistData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                      nameKey="name"
                    >
                      {activityDistData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-6 space-y-2">
                {activityDistData.slice(0, 4).map((item, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                      <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{item.name}</span>
                    </div>
                    <span className="text-xs font-black text-zinc-900 dark:text-white">{item.value}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Top Issues Summary */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <motion.div 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="glass-card p-6 md:p-8 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800"
            >
              <h4 className="text-xl font-display font-black text-zinc-900 dark:text-white mb-6 flex items-center gap-2">
                <EyeOff className="text-red-500" size={20} />
                {lang === 'ar' ? 'أكثر البراندات إخفاءً' : 'Top Brands with Hidden Items'}
              </h4>
              <div className="space-y-4">
                {sortedBrands.filter(b => b.hidden_products > 0).slice(0, 5).map((b, i) => (
                  <div key={i} className="flex items-center justify-between p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 group hover:border-red-200 transition-all">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-zinc-900 text-white flex items-center justify-center text-[10px] font-black uppercase">
                        {b.brand_name.substring(0, 2)}
                      </div>
                      <span className="text-sm font-black text-zinc-900 dark:text-white">{b.brand_name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-red-500">{b.hidden_products} {lang === 'ar' ? 'مخفي' : 'Hidden'}</span>
                      <div className="w-16 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-red-500" 
                          style={{ width: `${(b.hidden_products / b.total_products) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="glass-card p-6 md:p-8 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800"
            >
              <h4 className="text-xl font-display font-black text-zinc-900 dark:text-white mb-6 flex items-center gap-2">
                <Clock className="text-brand" size={20} />
                {lang === 'ar' ? 'أكثر الفروع انشغالاً' : 'Top Busy Branches'}
              </h4>
              <div className="space-y-4">
                {sortedBusy.slice(0, 5).map((b, i) => (
                  <div key={i} className="flex items-center justify-between p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 group hover:border-brand/30 transition-all">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
                        <Building2 size={16} />
                      </div>
                      <span className="text-sm font-black text-zinc-900 dark:text-white">{b.branch_name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-brand">{b.total_minutes} {lang === 'ar' ? 'دقيقة' : 'Min'}</span>
                      <div className="w-16 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-brand" 
                          style={{ width: `${Math.min((b.total_minutes / 500) * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Recent Activity Table in General Tab */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
              <div>
                <h3 className="text-2xl md:text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                  {lang === 'ar' ? 'آخر النشاطات' : 'Recent Activity'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'أحدث الإجراءات المتخذة في النظام' : 'Latest actions taken in the system'}
                </p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-[2rem] md:rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900/50">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-zinc-50 dark:bg-zinc-800/50">
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'الوقت (الكويت)' : 'Time (Kuwait)'}</th>
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'المستخدم' : 'User'}</th>
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'الإجراء' : 'Action'}</th>
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'التفاصيل' : 'Details'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {userActivityDetails.slice(0, 10).map((log, i) => (
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
                        <span className="font-black text-zinc-900 dark:text-white tracking-tight">{log.username}</span>
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
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        </div>
      )}

      {activeSubTab === 'hide' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
          {/* Brand Performance */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="xl:col-span-2 glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
              <div>
                <h3 className="text-2xl md:text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                  {lang === 'ar' ? 'أداء البراندات' : 'Brand Performance'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'مقاييس صحة المخزون والظهور' : 'Inventory health and visibility metrics'}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-brand" />
                  <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'الإجمالي' : 'Total'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-500" />
                  <span className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'مخفي' : 'Hidden'}</span>
                </div>
              </div>
            </div>

            <div className="h-[300px] md:h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sortedBrands} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f1f1" />
                  <XAxis 
                    dataKey="brand_name" 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fill: '#9ca3af', fontSize: 10, fontWeight: 900 }}
                    dy={10}
                  />
                  <YAxis 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fill: '#9ca3af', fontSize: 10, fontWeight: 900 }}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="total_products" fill="#F27D26" radius={[6, 6, 0, 0]} barSize={40} name={lang === 'ar' ? 'إجمالي المنتجات' : 'Total Products'} />
                  <Bar dataKey="hidden_products" fill="#EF4444" radius={[6, 6, 0, 0]} barSize={40} name={lang === 'ar' ? 'المنتجات المخفية' : 'Hidden Products'} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* Branch Visibility */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
            className="glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
          >
            <div className="mb-10">
              <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                {lang === 'ar' ? 'ظهور الفروع' : 'Branch Visibility'}
              </h3>
              <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                {lang === 'ar' ? 'حصة حوادث الإخفاء حسب الموقع' : 'Hide incidents share by location'}
              </p>
            </div>

            <div className="h-[250px] md:h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={sortedHides}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={8}
                    dataKey="total_count"
                    nameKey="branch_name"
                  >
                    {sortedHides.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-8 space-y-3">
              {sortedHides.slice(0, 4).map((h, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">{h.branch_name}</span>
                  </div>
                  <span className="text-xs font-black text-zinc-900 dark:text-white">{h.total_count}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      )}

      {activeSubTab === 'busy' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
          {/* Root Causes */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
            className="glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
          >
            <div className="mb-10">
              <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                {lang === 'ar' ? 'الأسباب الجذرية' : 'Root Causes'}
              </h3>
              <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                {lang === 'ar' ? 'توزيع فئات الحوادث' : 'Distribution of incident categories'}
              </p>
            </div>

            <div className="h-[250px] md:h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={reasonsReport}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={8}
                    dataKey="value"
                    nameKey="name"
                  >
                    {reasonsReport.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-8 space-y-4">
              {reasonsReport.slice(0, 5).map((r, i) => (
                <div key={i} className="flex items-center justify-between group">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 rounded-full transition-transform group-hover:scale-125" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">{r.name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="w-24 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div 
                        className="h-full rounded-full" 
                        style={{ 
                          backgroundColor: COLORS[i % COLORS.length],
                          width: `${(r.value / reasonsReport.reduce((acc, curr) => acc + curr.value, 0)) * 100}%` 
                        }} 
                      />
                    </div>
                    <span className="text-xs font-black text-zinc-900 dark:text-white min-w-[2rem] text-right">{r.value}</span>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Operational Efficiency */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="xl:col-span-3 glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
          >
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
              <div>
                <h3 className="text-2xl md:text-4xl font-display font-black text-zinc-900 dark:text-white tracking-tighter">
                  {lang === 'ar' ? 'الكفاءة التشغيلية' : 'Operational Efficiency'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'أداء الفروع المفصل ومقاييس وقت التوقف' : 'Detailed branch performance and downtime metrics'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* Download button moved to header */}
              </div>
            </div>

            <div className="overflow-x-auto rounded-[2rem] md:rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900/50">
              <table className="w-full text-left border-collapse min-w-[800px]">
                <thead>
                  <tr className="bg-zinc-50 dark:bg-zinc-800/50">
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'موقع الفرع' : 'Branch Location'}</th>
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest text-center">{lang === 'ar' ? 'الحوادث' : 'Incidents'}</th>
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest text-center">{lang === 'ar' ? 'إجمالي المدة' : 'Total Duration'}</th>
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest text-center">{lang === 'ar' ? 'متوسط الاستجابة' : 'Avg Response'}</th>
                    <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest text-center">{lang === 'ar' ? 'حالة الصحة' : 'Health Status'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800">
                  {sortedBusy.map((b, i) => (
                    <tr key={i} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-all group">
                      <td className="px-10 py-6">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 group-hover:bg-brand group-hover:text-white transition-all shadow-sm">
                            <Building2 size={20} />
                          </div>
                          <div>
                            <p className="font-black text-zinc-900 dark:text-white text-lg tracking-tight">{b.branch_name}</p>
                            <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Operational Hub</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-10 py-6 text-center">
                        <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 font-black text-zinc-900 dark:text-white">
                          {b.total_instances}
                        </span>
                      </td>
                      <td className="px-10 py-6 text-center">
                        <div className="space-y-2">
                          <p className="font-black text-brand text-lg">{b.total_minutes || 0}m</p>
                          <div className="w-24 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full mx-auto overflow-hidden">
                            <div 
                              className="h-full bg-brand rounded-full" 
                              style={{ width: `${Math.min((b.total_minutes || 0) / 5, 100)}%` }} 
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-10 py-6 text-center">
                        <p className="font-bold text-zinc-500">{Math.round(b.avg_minutes || 0)}m</p>
                      </td>
                      <td className="px-10 py-6 text-center">
                        <div className="flex items-center justify-center">
                          <div className={cn(
                            "flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border shadow-sm",
                            (b.total_minutes || 0) > 100 
                              ? "bg-red-50 text-red-600 border-red-100" 
                              : (b.total_minutes || 0) > 50 
                                ? "bg-amber-50 text-amber-600 border-amber-100"
                                : "bg-emerald-50 text-emerald-600 border-emerald-100"
                          )}>
                            {(b.total_minutes || 0) > 100 ? <AlertTriangle size={12} /> : (b.total_minutes || 0) > 50 ? <Zap size={12} /> : <ShieldCheck size={12} />}
                            {(b.total_minutes || 0) > 100 ? (lang === 'ar' ? 'حرج' : 'Critical') : (b.total_minutes || 0) > 50 ? (lang === 'ar' ? 'تحذير' : 'Warning') : (lang === 'ar' ? 'مستقر' : 'Stable')}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        </div>
      )}

      {activeSubTab === 'kpi' && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
            <div>
              <h3 className="text-2xl md:text-4xl font-display font-black text-zinc-900 dark:text-white tracking-tighter">
                {lang === 'ar' ? 'أداء مؤشرات الأداء للمستخدمين' : 'User KPI Performance'}
              </h3>
              <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                {lang === 'ar' ? 'تتبع النشاط ومقاييس التفاعل مع النظام' : 'Activity tracking and system engagement metrics'}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
                <Users size={16} className="text-zinc-400" />
                <select 
                  className="bg-transparent border-none outline-none text-xs font-black text-zinc-900 dark:text-white uppercase tracking-wider"
                  value={filters.user}
                  onChange={(e) => setFilters({...filters, user: e.target.value})}
                >
                  <option value="all">{lang === 'ar' ? 'كل المستخدمين' : 'All Users'}</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 md:gap-6 mb-10">
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
                <div key={action} className="bg-zinc-50 dark:bg-zinc-800/50 p-4 md:p-6 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                  <div className="flex items-center justify-between mb-4">
                    <div className={cn("w-8 h-8 md:w-10 md:h-10 rounded-xl flex items-center justify-center", 
                      action === 'BUSY' ? "bg-brand/10 text-brand" : `bg-${color}/10 text-${color}`)}>
                      <Icon size={18} />
                    </div>
                    <span className="text-[8px] md:text-[10px] font-black text-zinc-400 uppercase tracking-widest">{action}</span>
                  </div>
                  <h5 className="text-2xl md:text-3xl font-display font-black text-zinc-900 dark:text-white">{count}</h5>
                </div>
              );
            })}
          </div>

          {/* User Leaderboard */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-10">
            <motion.div 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="lg:col-span-2 glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
            >
              <div className="mb-10">
                <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                  {lang === 'ar' ? 'لوحة المتصدرين للمستخدمين' : 'User Performance Leaderboard'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'المستخدمون الأكثر نشاطاً في النظام' : 'Most active users in the system'}
                </p>
              </div>
              <div className="space-y-6">
                {userLeaderboard.slice(0, 5).map((user: any, i) => (
                  <div key={i} className="flex items-center justify-between group">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-zinc-900 text-white flex items-center justify-center font-black text-lg">
                        {i + 1}
                      </div>
                      <div>
                        <p className="font-black text-zinc-900 dark:text-white tracking-tight">{user.username}</p>
                        <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'مستخدم نشط' : 'Active User'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="font-black text-zinc-900 dark:text-white text-xl">{user.total}</p>
                        <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'إجراء' : 'Actions'}</p>
                      </div>
                      <div className="w-32 h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden hidden md:block">
                        <div 
                          className="h-full bg-brand rounded-full" 
                          style={{ width: `${(user.total / userLeaderboard[0].total) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="glass-card p-6 md:p-10 rounded-[2.5rem] md:rounded-[3rem] border border-zinc-100 dark:border-zinc-800 shadow-2xl shadow-zinc-900/5"
            >
              <div className="mb-10">
                <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                  {lang === 'ar' ? 'ملخص النشاط' : 'Activity Summary'}
                </h3>
                <p className="text-[10px] md:text-xs text-zinc-500 font-bold uppercase tracking-widest mt-1">
                  {lang === 'ar' ? 'نظرة عامة على التفاعل' : 'Engagement overview'}
                </p>
              </div>
              <div className="space-y-8">
                <div className="p-6 rounded-3xl bg-brand/5 border border-brand/10">
                  <p className="text-[10px] font-black text-brand uppercase tracking-widest mb-2">{lang === 'ar' ? 'المستخدم الأكثر نشاطاً' : 'Top Performer'}</p>
                  <h4 className="text-2xl font-display font-black text-zinc-900 dark:text-white">{userLeaderboard[0]?.username || 'N/A'}</h4>
                  <p className="text-xs font-bold text-zinc-500 mt-1">{userLeaderboard[0]?.total || 0} {lang === 'ar' ? 'إجراء مسجل' : 'Actions recorded'}</p>
                </div>
                <div className="p-6 rounded-3xl bg-emerald-500/5 border border-emerald-500/10">
                  <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2">{lang === 'ar' ? 'إجمالي نشاط الفريق' : 'Total Team Activity'}</p>
                  <h4 className="text-2xl font-display font-black text-zinc-900 dark:text-white">{userLeaderboard.reduce((acc: any, curr: any) => acc + curr.total, 0)}</h4>
                  <p className="text-xs font-bold text-zinc-500 mt-1">{lang === 'ar' ? 'إجمالي الإجراءات في الفترة المختارة' : 'Total actions in selected period'}</p>
                </div>
              </div>
            </motion.div>
          </div>

          <div className="overflow-x-auto rounded-[2rem] md:rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900/50">
            <table className="w-full text-left border-collapse min-w-[700px]">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800/50">
                  <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'الوقت (الكويت)' : 'Time (Kuwait)'}</th>
                  <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'المستخدم' : 'User'}</th>
                  <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'الإجراء' : 'Action'}</th>
                  <th className="px-6 md:px-10 py-6 text-[10px] font-black text-zinc-400 uppercase tracking-widest">{lang === 'ar' ? 'التفاصيل' : 'Details'}</th>
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
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 group-hover:bg-brand group-hover:text-white transition-all shadow-sm">
                          <Users size={18} />
                        </div>
                        <span className="font-black text-zinc-900 dark:text-white tracking-tight">{log.username}</span>
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
                    <td colSpan={4} className="px-10 py-12 text-center text-zinc-400 font-bold uppercase tracking-widest text-xs">
                      No activity found for the selected filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}
    </div>
  );
}
