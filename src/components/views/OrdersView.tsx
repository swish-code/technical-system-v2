import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate, safeJson } from '../../lib/utils';
import { 
  Search, 
  Filter, 
  Download, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  AlertCircle,
  Eye,
  EyeOff,
  Activity,
  ChevronDown,
  Calendar,
  User,
  MapPin,
  Tag,
  FileText,
  RefreshCw,
  Globe,
  Inbox
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useFetch } from '../../hooks/useFetch';
import * as XLSX from 'xlsx';

interface Order {
  id: number;
  user_id: number;
  type: string;
  data: any;
  status: string;
  created_at: string;
  updated_at: string;
  processed_by: number | null;
  username: string;
  processor_name: string | null;
}

export default function OrdersView() {
  const { lang, user } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [orders, setOrders] = useState<Order[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [brandFilter, setBrandFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: itemsPerPage.toString(),
        status: statusFilter,
        type: typeFilter,
        brand: brandFilter,
        search: searchTerm,
        date: dateFilter
      });
      const res = await fetchWithAuth(`${API_URL}/pending-requests?${params.toString()}`);
      if (res.ok) {
        const result = await res.json();
        setOrders(result.data);
        setTotalOrders(result.total);
      }
    } catch (e) {
      console.error("Failed to fetch orders", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [currentPage, statusFilter, typeFilter, brandFilter, dateFilter]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentPage === 1) fetchOrders();
      else setCurrentPage(1);
    }, 500);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'PENDING_REQUEST_CREATED' || data.type === 'PENDING_REQUEST_UPDATED') {
        fetchOrders();
      }
    };
    return () => ws.close();
  }, []);

  const [brands, setBrands] = useState<string[]>([]);
  useEffect(() => {
    const fetchBrands = async () => {
      const res = await fetchWithAuth(`${API_URL}/brands`);
      if (res.ok) {
        const data = await res.json();
        setBrands(data.map((b: any) => b.name));
      }
    };
    fetchBrands();
  }, []);

  const totalPages = Math.ceil(totalOrders / itemsPerPage);
  const paginatedOrders = orders; // Already paginated by server

  const exportToCSV = async () => {
    setLoading(true);
    try {
      // Fetch all filtered data without pagination for export
      const params = new URLSearchParams({
        status: statusFilter,
        type: typeFilter,
        brand: brandFilter,
        search: searchTerm,
        date: dateFilter
      });
      const res = await fetchWithAuth(`${API_URL}/pending-requests?${params.toString()}`);
      if (res.ok) {
        const allOrders = await res.json();
        const data = allOrders.map((o: Order) => {
          let typeLabel = o.type;
          const action = o.data?.action;
          if (o.type === 'hide_unhide') {
            typeLabel = action === 'UNHIDE' ? 'Unhide Item' : 'Hide Item';
          } else if (o.type === 'busy_branch') {
            typeLabel = action === 'OPEN' ? 'Open Branch' : 'Busy Branch';
          }

          return {
            'Order ID': o.id,
            'Type': typeLabel,
            'Brand': o.type === 'hide_unhide' ? o.data.brand_name : o.data.brand,
            'Branch': o.type === 'hide_unhide' ? o.data.branch_name : o.data.branch,
            'Item': o.type === 'hide_unhide' ? o.data.resolved_products?.map((p: any) => p.name).join(', ') : '-',
            'Reason': o.type === 'hide_unhide' ? o.data.reason : o.data.reason_category,
            'Created At': formatDate(o.created_at),
            'Status': o.status,
            'Approved By': o.processor_name || '-',
            'Approved At': o.status === 'Approved' ? formatDate(o.updated_at) : '-'
          };
        });

        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Orders");
        XLSX.writeFile(wb, `Orders_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
      }
    } catch (e) {
      console.error("Export failed", e);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Pending':
        return (
          <span className="px-3 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 w-fit">
            <Clock size={12} />
            {lang === 'en' ? 'Pending' : 'قيد الانتظار'}
          </span>
        );
      case 'Approved':
        return (
          <span className="px-3 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 w-fit">
            <CheckCircle2 size={12} />
            {lang === 'en' ? 'Approved' : 'تم الموافقة'}
          </span>
        );
      case 'Rejected':
        return (
          <span className="px-3 py-1 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 w-fit">
            <XCircle size={12} />
            {lang === 'en' ? 'Rejected' : 'تم الرفض'}
          </span>
        );
      default:
        return null;
    }
  };

  const getTypeBadge = (order: any) => {
    const type = order.type;
    const action = order.data?.action;

    if (type === 'hide_unhide') {
      if (action === 'UNHIDE') {
        return (
          <span className="flex items-center gap-2 text-zinc-900 dark:text-white font-bold text-sm">
            <div className="p-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
              <Eye size={14} className="text-emerald-500" />
            </div>
            {lang === 'en' ? 'Unhide Item' : 'إظهار منتج'}
          </span>
        );
      }
      return (
        <span className="flex items-center gap-2 text-zinc-900 dark:text-white font-bold text-sm">
          <div className="p-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
            <EyeOff size={14} className="text-rose-500" />
          </div>
          {lang === 'en' ? 'Hide Item' : 'إخفاء منتج'}
        </span>
      );
    }

    if (type === 'busy_branch') {
      if (action === 'OPEN') {
        return (
          <span className="flex items-center gap-2 text-zinc-900 dark:text-white font-bold text-sm">
            <div className="p-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
              <CheckCircle2 size={14} className="text-emerald-500" />
            </div>
            {lang === 'en' ? 'Open Branch' : 'فتح فرع'}
          </span>
        );
      }
      return (
        <span className="flex items-center gap-2 text-zinc-900 dark:text-white font-bold text-sm">
          <div className="p-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
            <Activity size={14} className="text-amber-500" />
          </div>
          {lang === 'en' ? 'Busy Branch' : 'فرع مشغول'}
        </span>
      );
    }

    return (
      <span className="flex items-center gap-2 text-zinc-900 dark:text-white font-bold text-sm">
        <div className="p-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
          <FileText size={14} className="text-zinc-500" />
        </div>
        {type}
      </span>
    );
  };

  return (
    <div className="space-y-8 pb-20">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-brand rounded-xl text-white shadow-lg shadow-brand/20">
              <FileText size={24} strokeWidth={2.5} />
            </div>
            <h2 className="text-4xl font-black text-zinc-900 dark:text-white tracking-tight">
              {lang === 'en' ? 'Orders' : 'الطلبات'}
            </h2>
          </div>
          <p className="text-zinc-500 dark:text-zinc-400 font-semibold mt-1">
            {lang === 'en' ? 'Monitor and track your requests to the Technical Back Office.' : 'راقب وتتبع طلباتك المرسلة إلى المكتب الفني.'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={fetchOrders}
            className="p-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-zinc-500 hover:text-brand transition-all shadow-sm"
          >
            <RefreshCw size={20} className={cn(loading && "animate-spin")} />
          </button>
          <button 
            onClick={exportToCSV}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-white rounded-xl font-black text-sm hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20 active:scale-95"
          >
            <Download size={18} />
            {lang === 'en' ? 'Export Excel' : 'تصدير إكسيل'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-zinc-900 p-6 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">{lang === 'en' ? 'Search' : 'بحث'}</label>
            <div className="relative group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
              <input 
                type="text"
                placeholder={lang === 'en' ? "Order ID..." : "رقم الطلب..."}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none text-sm font-bold text-zinc-900 dark:text-white transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">{lang === 'en' ? 'Status' : 'الحالة'}</label>
            <div className="relative group">
              <Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
              <select 
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none text-sm font-bold text-zinc-900 dark:text-white appearance-none cursor-pointer transition-all"
              >
                <option value="all">{lang === 'en' ? 'All Statuses' : 'كل الحالات'}</option>
                <option value="Pending">{lang === 'en' ? 'Pending' : 'قيد الانتظار'}</option>
                <option value="Approved">{lang === 'en' ? 'Approved' : 'تم الموافقة'}</option>
                <option value="Rejected">{lang === 'en' ? 'Rejected' : 'تم الرفض'}</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={16} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">{lang === 'en' ? 'Type' : 'النوع'}</label>
            <div className="relative group">
              <Tag className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
              <select 
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none text-sm font-bold text-zinc-900 dark:text-white appearance-none cursor-pointer transition-all"
              >
                <option value="all">{lang === 'en' ? 'All Types' : 'كل الأنواع'}</option>
                <option value="HIDE">{lang === 'en' ? 'Hide Item' : 'إخفاء منتج'}</option>
                <option value="UNHIDE">{lang === 'en' ? 'Unhide Item' : 'إظهار منتج'}</option>
                <option value="BUSY">{lang === 'en' ? 'Busy Branch' : 'فرع مشغول'}</option>
                <option value="OPEN">{lang === 'en' ? 'Open Branch' : 'فتح فرع'}</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={16} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">{lang === 'en' ? 'Brand' : 'البراند'}</label>
            <div className="relative group">
              <Globe className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
              <select 
                value={brandFilter}
                onChange={(e) => setBrandFilter(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none text-sm font-bold text-zinc-900 dark:text-white appearance-none cursor-pointer transition-all"
              >
                <option value="all">{lang === 'en' ? 'All Brands' : 'كل البراندات'}</option>
                {brands.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={16} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">{lang === 'en' ? 'Date' : 'التاريخ'}</label>
            <div className="relative group">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
              <input 
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none text-sm font-bold text-zinc-900 dark:text-white transition-all"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Orders Table */}
      <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50/50 dark:bg-zinc-800/50">
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-400">{lang === 'en' ? 'Order ID' : 'رقم الطلب'}</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-400">{lang === 'en' ? 'Type' : 'النوع'}</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-400">{lang === 'en' ? 'Brand / Branch' : 'البراند / الفرع'}</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-400">{lang === 'en' ? 'Item / Reason' : 'المنتج / السبب'}</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-400">{lang === 'en' ? 'Created At' : 'تاريخ الطلب'}</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-400">{lang === 'en' ? 'Status' : 'الحالة'}</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-zinc-400">{lang === 'en' ? 'Approval' : 'الموافقة'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              <AnimatePresence mode="popLayout">
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={7} className="px-6 py-8">
                        <div className="h-4 bg-zinc-100 dark:bg-zinc-800 rounded-full w-full" />
                      </td>
                    </tr>
                  ))
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-20 text-center">
                      <div className="flex flex-col items-center gap-4 text-zinc-400">
                        <Inbox size={48} strokeWidth={1} className="opacity-20" />
                        <p className="text-sm font-bold uppercase tracking-widest opacity-40">
                          {lang === 'en' ? 'No orders found' : 'لا توجد طلبات'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  orders.map((order, idx) => (
                    <motion.tr 
                      key={order.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.02 }}
                      className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-all group"
                    >
                      <td className="px-6 py-5">
                        <span className="text-xs font-black text-zinc-900 dark:text-white">#{order.id}</span>
                      </td>
                      <td className="px-6 py-5">
                        {getTypeBadge(order)}
                      </td>
                      <td className="px-6 py-5">
                        <div className="space-y-1">
                          <p className="text-xs font-black text-zinc-900 dark:text-white">
                            {order.type === 'hide_unhide' ? order.data.brand_name : order.data.brand}
                          </p>
                          <div className="flex items-center gap-1.5 text-zinc-400">
                            <MapPin size={10} />
                            <span className="text-[10px] font-bold uppercase tracking-tight">
                              {order.type === 'hide_unhide' ? order.data.branch_name : order.data.branch}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <div className="space-y-1 max-w-[200px]">
                          {order.type === 'hide_unhide' ? (
                            <p className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                              {order.data.resolved_products?.map((p: any) => p.name).join(', ') || 'Multiple Products'}
                            </p>
                          ) : (
                            <p className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                              {order.data.reason_category}
                            </p>
                          )}
                          <p className="text-[10px] text-zinc-400 font-medium truncate italic">
                            {order.type === 'hide_unhide' ? order.data.reason : order.data.comment}
                          </p>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <div className="space-y-1">
                          <p className="text-xs font-bold text-zinc-900 dark:text-white">{formatDate(order.created_at, { month: 'short', day: 'numeric' })}</p>
                          <p className="text-[10px] text-zinc-400 font-medium">{formatDate(order.created_at, { hour: '2-digit', minute: '2-digit' })}</p>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        {getStatusBadge(order.status)}
                      </td>
                      <td className="px-6 py-5">
                        {order.status === 'Approved' ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                              <User size={12} />
                              <span className="text-[10px] font-black uppercase tracking-tight">{order.processor_name}</span>
                            </div>
                            <p className="text-[10px] text-zinc-400 font-medium">{formatDate(order.updated_at, { hour: '2-digit', minute: '2-digit' })}</p>
                          </div>
                        ) : (
                          <span className="text-[10px] font-bold text-zinc-300 dark:text-zinc-700 uppercase tracking-widest">
                            {order.status === 'Pending' ? (lang === 'en' ? 'Awaiting Approval' : 'في انتظار الموافقة') : '-'}
                          </span>
                        )}
                      </td>
                    </motion.tr>
                  ))
                )}
              </AnimatePresence>
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-6 border-t border-zinc-100 dark:divide-zinc-800 flex items-center justify-center gap-2">
            <button
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="px-4 py-2 rounded-xl text-sm font-bold text-zinc-500 hover:text-zinc-900 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {lang === 'en' ? 'Previous' : 'السابق'}
            </button>

            <div className="flex items-center gap-1">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => {
                // Logic to show limited page numbers with ellipsis
                if (
                  page === 1 || 
                  page === totalPages || 
                  (page >= currentPage - 1 && page <= currentPage + 1)
                ) {
                  return (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={cn(
                        "w-10 h-10 rounded-xl text-sm font-black transition-all",
                        currentPage === page 
                          ? "bg-brand text-white shadow-lg shadow-brand/20 scale-110" 
                          : "text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      )}
                    >
                      {page}
                    </button>
                  );
                } else if (
                  page === currentPage - 2 || 
                  page === currentPage + 2
                ) {
                  return <span key={page} className="text-zinc-400 px-1">...</span>;
                }
                return null;
              })}
            </div>

            <button
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages}
              className="px-4 py-2 rounded-xl text-sm font-bold text-zinc-500 hover:text-zinc-900 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {lang === 'en' ? 'Next' : 'التالي'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
