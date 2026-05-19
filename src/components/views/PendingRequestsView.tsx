import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate, safeJson } from '../../lib/utils';
import { CheckCircle2, XCircle, Clock, User, AlertCircle, Eye, Check, X, Loader2, Download, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PendingRequest } from '../../types';
import * as XLSX from 'xlsx';

import { useFetch } from '../../hooks/useFetch';
import { useWebSocket } from '../../hooks/useWebSocket';

interface PendingRequestsViewProps {
  filterType?: 'hide_unhide' | 'busy_branch';
}

export default function PendingRequestsView({ filterType }: PendingRequestsViewProps) {
  const { lang, user } = useAuth();
  const { fetchWithAuth } = useFetch();
  const lastMessage = useWebSocket();
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<PendingRequest | null>(null);
  const [viewMode, setViewMode] = useState<'pending' | 'history'>('pending');
  const [typeFilter, setTypeFilter] = useState<'all' | 'hide_unhide' | 'busy_branch' | 'HIDE' | 'UNHIDE' | 'BUSY' | 'OPEN'>('all');
  const [brandFilter, setBrandFilter] = useState<string>('all');
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [brands, setBrands] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  const fetchRequests = async () => {
    setLoading(true);
    setError(null);
    try {
      const [reqRes, brandsRes, branchesRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/pending-requests`),
        fetchWithAuth(`${API_URL}/brands`),
        fetchWithAuth(`${API_URL}/branches`)
      ]);

      if (reqRes.ok) {
        const data = await safeJson(reqRes);
        let filteredData = Array.isArray(data) ? data : [];
        if (filterType) {
          filteredData = filteredData.filter(r => r.type === filterType);
        }
        setRequests(filteredData);
      } else {
        const errorData = await safeJson(reqRes);
        throw new Error(errorData?.error || `Failed to fetch requests: ${reqRes.status}`);
      }

      if (brandsRes.ok) {
        const data = await safeJson(brandsRes);
        setBrands(Array.isArray(data) ? data : []);
      }
      if (branchesRes.ok) {
        let data = await safeJson(branchesRes) || [];
        
        // Filter for Restaurants role
        if (user?.role_name === 'Restaurants' && user.branch_id) {
          data = data.filter((b: any) => b.id === user.branch_id);
        }
        
        setBranches(data);
        if (data.length === 1) {
          setBranchFilter(data[0].id.toString());
        }
      }
    } catch (error: any) {
      if (error.isAuthError) return;
      console.error("Error fetching requests:", error);
      setError(error.message || 'An unexpected error occurred while fetching requests.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'PENDING_REQUEST_CREATED' || lastMessage?.type === 'PENDING_REQUEST_UPDATED') {
      fetchRequests();
    }
  }, [lastMessage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [viewMode, typeFilter, brandFilter, branchFilter]);

  const handleAction = async (id: number, action: 'approve' | 'reject') => {
    setProcessingId(id);
    try {
      const res = await fetchWithAuth(`${API_URL}/pending-requests/${id}/${action}`, {
        method: 'POST'
      });
      if (res.ok) {
        fetchRequests();
        if (selectedRequest?.id === id) setSelectedRequest(null);
      }
    } catch (error: any) {
      if (error.isAuthError) return;
      console.error(`Error ${action}ing request:`, error);
    } finally {
      setProcessingId(null);
    }
  };

  const downloadExcel = () => {
    // Filter for non-pending requests (Approved or Rejected)
    const historyRequests = requests.filter(r => r.status && r.status !== 'Pending');
    
    if (historyRequests.length === 0) {
      alert(lang === 'en' ? 'No history data to download' : 'لا توجد بيانات في السجل للتحميل');
      return;
    }

    const dataToExport = historyRequests.map(req => {
      const data = req.data || {};
      
      // Base information present in all requests
      const common: any = {
        'ID': req.id,
        'Type': req.type === 'hide_unhide' ? 'Hide/Unhide' : 'Busy Branch',
        'Status': req.status,
        'Requester': req.username || 'Unknown',
        'Request Date': formatDate(req.created_at),
        'Branch': data.branch_name || data.branch || 'All Branches',
        'Brand': data.brand_name || data.brand || '',
        'Processor': req.processor_name || 'System',
        'Action Date': formatDate(req.updated_at),
      };

      // Type-specific details
      if (req.type === 'hide_unhide') {
        return {
          ...common,
          'Agent Name': data.agent_name || '',
          'Reason': data.reason || '',
          'Responsible Party': data.responsible_party || '',
          'Products': data.resolved_products?.map((p: any) => p.name).join(', ') || '',
          'Comment': data.comment || '',
        };
      } else {
        return {
          ...common,
          'Date': data.date || '',
          'Start Time': data.start_time || '',
          'End Time': data.end_time || '',
          'Duration': data.total_duration || '',
          'Reason Category': data.reason_category || '',
          'Responsible Party': data.responsible_party || '',
          'Comment': data.comment || '',
          'Internal Notes': data.internal_notes || '',
        };
      }
    });

    try {
      const worksheet = XLSX.utils.json_to_sheet(dataToExport);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "History");
      
      // Generate the Excel file and trigger download
      XLSX.writeFile(workbook, `Requests_History_${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch (error) {
      console.error("Excel export failed:", error);
      alert(lang === 'en' ? "Failed to generate Excel file" : "فشل في إنشاء ملف الإكسيل");
    }
  };

  const filteredRequests = requests.filter(r => {
    const matchesMode = viewMode === 'pending' ? r.status === 'Pending' : r.status !== 'Pending';
    let matchesType = typeFilter === 'all';
    if (!matchesType) {
      const action = r.data?.action;
      if (typeFilter === 'HIDE') matchesType = r.type === 'hide_unhide' && action === 'HIDE';
      else if (typeFilter === 'UNHIDE') matchesType = r.type === 'hide_unhide' && action === 'UNHIDE';
      else if (typeFilter === 'BUSY') matchesType = r.type === 'busy_branch' && (action === 'BUSY' || !action);
      else if (typeFilter === 'OPEN') matchesType = r.type === 'busy_branch' && action === 'OPEN';
      else matchesType = r.type === typeFilter;
    }
    
    const data = r.data || {};
    const brandName = data.brand_name || data.brand || '';
    const branchName = data.branch_name || data.branch || '';
    
    const matchesBrand = brandFilter === 'all' || brandName === brandFilter;
    const matchesBranch = branchFilter === 'all' || branchName === branchFilter;
    
    return matchesMode && matchesType && matchesBrand && matchesBranch;
  });

  const totalPages = Math.ceil(filteredRequests.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRequests = filteredRequests.slice(startIndex, startIndex + pageSize);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-6">
        <div className="w-20 h-20 bg-red-50 dark:bg-red-900/20 rounded-3xl flex items-center justify-center text-red-500 shadow-xl shadow-red-500/10">
          <AlertCircle size={40} />
        </div>
        <div className="text-center space-y-2">
          <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">
            {lang === 'ar' ? 'خطأ في تحميل البيانات' : 'Error Loading Data'}
          </h3>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium max-w-md mx-auto">
            {error}
          </p>
        </div>
        <button
          onClick={() => fetchRequests()}
          className="px-8 py-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-2xl font-black shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3"
        >
          <RefreshCw size={20} />
          {lang === 'ar' ? 'إعادة المحاولة' : 'Retry Connection'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h2 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">
          {lang === 'en' ? 'Requests Management' : 'إدارة الطلبات'}
        </h2>
        
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as any)}
            className="px-4 py-2 bg-white dark:bg-zinc-800 border-2 border-zinc-100 dark:border-zinc-700 rounded-xl font-bold text-sm outline-none focus:border-brand transition-all text-zinc-900 dark:text-white"
          >
            <option value="all">{lang === 'en' ? 'All Types' : 'جميع الأنواع'}</option>
            <option value="HIDE">{lang === 'en' ? 'Hide Item' : 'إخفاء منتج'}</option>
            <option value="UNHIDE">{lang === 'en' ? 'Unhide Item' : 'إظهار منتج'}</option>
            <option value="BUSY">{lang === 'en' ? 'Busy Branch' : 'فرع مشغول'}</option>
            <option value="OPEN">{lang === 'en' ? 'Open Branch' : 'فتح فرع'}</option>
          </select>

          <select
            value={brandFilter}
            onChange={(e) => {
              setBrandFilter(e.target.value);
              setBranchFilter('all');
            }}
            className="px-4 py-2 bg-white dark:bg-zinc-800 border-2 border-zinc-100 dark:border-zinc-700 rounded-xl font-bold text-sm outline-none focus:border-brand transition-all text-zinc-900 dark:text-white"
          >
            <option value="all">{lang === 'en' ? 'All Brands' : 'جميع العلامات التجارية'}</option>
            {brands.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
          </select>

          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="px-4 py-2 bg-white dark:bg-zinc-800 border-2 border-zinc-100 dark:border-zinc-700 rounded-xl font-bold text-sm outline-none focus:border-brand transition-all text-zinc-900 dark:text-white"
          >
            {user?.role_name !== 'Restaurants' && (
              <option value="all">{lang === 'en' ? 'All Branches' : 'جميع الفروع'}</option>
            )}
            {branches
              .filter(b => brandFilter === 'all' || b.brand_name === brandFilter)
              .map(b => <option key={b.id} value={b.name}>{b.name}</option>)
            }
          </select>

          <button
            onClick={downloadExcel}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl font-bold text-sm hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20 active:scale-95"
          >
            <Download size={18} />
            {lang === 'en' ? 'Download Excel' : 'تحميل إكسيل'}
          </button>

          <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl">
            <button
              onClick={() => setViewMode('pending')}
              className={cn(
                "px-6 py-2 rounded-lg text-sm font-black transition-all",
                viewMode === 'pending' 
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm" 
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              )}
            >
              {lang === 'en' ? 'Pending' : 'المعلقة'}
            </button>
            <button
              onClick={() => setViewMode('history')}
              className={cn(
                "px-6 py-2 rounded-lg text-sm font-black transition-all",
                viewMode === 'history' 
                  ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm" 
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              )}
            >
              {lang === 'en' ? 'History' : 'السجل'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {filteredRequests.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-12 text-center border border-zinc-200 dark:border-zinc-800">
            <CheckCircle2 className="w-12 h-12 text-zinc-200 dark:text-zinc-800 mx-auto mb-4" />
            <p className="text-zinc-500 font-bold">
              {viewMode === 'pending' 
                ? (lang === 'en' ? 'No pending requests' : 'لا توجد طلبات معلقة')
                : (lang === 'en' ? 'No history found' : 'لا يوجد سجل')}
            </p>
          </div>
        ) : (
          <>
            {paginatedRequests.map((request) => (
              <motion.div
                layout
                key={request.id}
                className={cn(
                  "bg-white dark:bg-zinc-900 rounded-2xl border p-5 transition-all",
                  request.status === 'Pending' ? "border-amber-200 dark:border-amber-900/30 bg-amber-50/10" :
                  request.status === 'Approved' ? "border-emerald-200 dark:border-emerald-900/30 bg-emerald-50/10" :
                  "border-red-200 dark:border-red-900/30 bg-red-50/10"
                )}
              >
                <div className="flex flex-wrap justify-between items-center gap-4">
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "w-12 h-12 rounded-xl flex items-center justify-center shadow-sm",
                      request.type === 'hide_unhide' 
                        ? "bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600" 
                        : "bg-amber-100 dark:bg-amber-900/50 text-amber-600"
                    )}>
                      {request.type === 'hide_unhide' ? <Eye size={20} /> : <Clock size={20} />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn(
                          "text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md border",
                          request.type === 'hide_unhide'
                            ? "bg-indigo-50 text-indigo-600 border-indigo-100 dark:bg-indigo-900/20 dark:border-indigo-800"
                            : "bg-amber-50 text-amber-600 border-amber-100 dark:bg-amber-900/20 dark:border-amber-800"
                        )}>
                          {request.type === 'hide_unhide' ? (lang === 'en' ? 'Hide/Unhide' : 'إخفاء/إظهار') : (lang === 'en' ? 'Busy Branch' : 'فرع مزدحم')}
                        </span>
                        <div className="w-1 h-1 rounded-full bg-zinc-300" />
                        <span className="text-xs font-black uppercase tracking-widest text-zinc-400">
                          {request.type === 'hide_unhide' ? (
                            request.data.action === 'UNHIDE' 
                              ? (lang === 'en' ? 'Unhide Request' : 'طلب إظهار')
                              : (lang === 'en' ? 'Hide Request' : 'طلب إخفاء')
                          ) : (
                            request.data.action === 'OPEN'
                              ? (lang === 'en' ? 'Open Branch Request' : 'طلب فتح فرع')
                              : (lang === 'en' ? 'Busy Branch Request' : 'طلب فرع مزدحم')
                          )}
                        </span>
                        <div className="w-1 h-1 rounded-full bg-zinc-300" />
                        <span className="text-xs font-bold text-zinc-500">{formatDate(request.created_at)}</span>
                      </div>
                      <h3 className="text-lg font-black text-zinc-900 dark:text-white">
                        {lang === 'en' ? 'From' : 'من'}: {request.username} 
                        {request.data.branch_name && <span className="text-zinc-400 font-medium ml-2">({request.data.branch_name})</span>}
                        {request.data.branch && <span className="text-zinc-400 font-medium ml-2">({request.data.branch})</span>}
                      </h3>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setSelectedRequest(request)}
                      className="p-2 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-xl hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-all"
                      title="View Details"
                    >
                      <Eye size={18} />
                    </button>
                    {request.status === 'Pending' && user?.role_name !== 'Restaurants' && (
                      <>
                        <button
                          onClick={() => handleAction(request.id, 'approve')}
                          disabled={processingId === request.id}
                          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl font-bold hover:bg-emerald-600 transition-all disabled:opacity-50"
                        >
                          {processingId === request.id ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                          {lang === 'en' ? 'Approve' : 'موافقة'}
                        </button>
                        <button
                          onClick={() => handleAction(request.id, 'reject')}
                          disabled={processingId === request.id}
                          className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-xl font-bold hover:bg-red-600 transition-all disabled:opacity-50"
                        >
                          {processingId === request.id ? <Loader2 size={18} className="animate-spin" /> : <X size={18} />}
                          {lang === 'en' ? 'Reject' : 'رفض'}
                        </button>
                      </>
                    )}
                    {request.status === 'Pending' && user?.role_name === 'Restaurants' && (
                      <div className="px-4 py-1.5 bg-amber-100 text-amber-700 rounded-xl font-bold text-xs uppercase tracking-widest">
                        {lang === 'en' ? 'Pending Approval' : 'في انتظار الموافقة'}
                      </div>
                    )}
                    {request.status !== 'Pending' && (
                      <div className="flex flex-col items-end">
                        <div className={cn(
                          "px-4 py-1.5 rounded-xl font-bold text-xs uppercase tracking-widest",
                          request.status === 'Approved' ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                        )}>
                          {request.status}
                        </div>
                        <div className="text-[10px] font-bold text-zinc-400 mt-1">
                          {lang === 'en' ? 'By' : 'بواسطة'}: {request.processor_name} • {formatDate(request.updated_at)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}

            {/* Pagination Controls */}
            {filteredRequests.length > pageSize && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 pb-2">
                <div className="text-zinc-500 dark:text-zinc-400 text-sm font-bold">
                  {lang === 'ar' 
                    ? `عرض ${startIndex + 1}-${Math.min(startIndex + pageSize, filteredRequests.length)} من ${filteredRequests.length} سجل`
                    : `Showing ${startIndex + 1}–${Math.min(startIndex + pageSize, filteredRequests.length)} of ${filteredRequests.length} records`}
                </div>
                
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 disabled:opacity-50 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all font-bold text-sm flex items-center gap-1"
                  >
                    <ChevronLeft size={16} />
                    {lang === 'ar' ? 'السابق' : 'Prev'}
                  </button>
                  
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum;
                      if (totalPages <= 5) pageNum = i + 1;
                      else if (currentPage <= 3) pageNum = i + 1;
                      else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                      else pageNum = currentPage - 2 + i;
                      
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setCurrentPage(pageNum)}
                          className={cn(
                            "w-10 h-10 rounded-xl font-black text-sm transition-all",
                            currentPage === pageNum 
                              ? "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 shadow-lg" 
                              : "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                          )}
                        >
                          {pageNum}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 disabled:opacity-50 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all font-bold text-sm flex items-center gap-1"
                  >
                    {lang === 'ar' ? 'التالي' : 'Next'}
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Details Modal */}
      <AnimatePresence>
        {selectedRequest && (
          <div className="fixed inset-0 flex items-center justify-center z-[100] p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedRequest(null)}
              className="absolute inset-0 bg-zinc-900/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-2xl"
            >
              <div className="p-8">
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h3 className="text-2xl font-black text-zinc-900 dark:text-white mb-1">
                      {lang === 'en' ? 'Request Details' : 'تفاصيل الطلب'}
                    </h3>
                    <p className="text-zinc-500 font-bold">{selectedRequest.type === 'hide_unhide' ? 'Hide / Unhide' : 'Busy Branch'}</p>
                  </div>
                  <button onClick={() => setSelectedRequest(null)} className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-all">
                    <X size={24} />
                  </button>
                </div>

                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    {Object.entries(selectedRequest.data).map(([key, value]: [string, any]) => {
                      if (key === 'product_ids' || key === 'resolved_products') return null;
                      return (
                        <div key={key} className="bg-zinc-50 dark:bg-zinc-800/50 p-4 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                          <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">{key.replace(/_/g, ' ')}</p>
                          <p className="font-bold text-zinc-900 dark:text-white">{String(value)}</p>
                        </div>
                      );
                    })}
                  </div>

                  {selectedRequest.type === 'hide_unhide' && selectedRequest.data.resolved_products && (
                    <div className="bg-zinc-50 dark:bg-zinc-800/50 p-4 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                      <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Products</p>
                      <div className="flex flex-wrap gap-2">
                        {selectedRequest.data.resolved_products.map((p: any) => (
                          <span key={p.product_id} className="px-3 py-1 bg-white dark:bg-zinc-900 rounded-lg text-xs font-bold border border-zinc-200 dark:border-zinc-800">
                            {p.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {selectedRequest.status === 'Pending' && user?.role_name !== 'Restaurants' && (
                  <div className="flex gap-3 mt-8">
                    <button
                      onClick={() => handleAction(selectedRequest.id, 'approve')}
                      disabled={processingId === selectedRequest.id}
                      className="flex-1 py-3 bg-emerald-500 text-white rounded-2xl font-black hover:bg-emerald-600 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {processingId === selectedRequest.id ? <Loader2 size={20} className="animate-spin" /> : <Check size={20} />}
                      {lang === 'en' ? 'Approve Request' : 'الموافقة على الطلب'}
                    </button>
                    <button
                      onClick={() => handleAction(selectedRequest.id, 'reject')}
                      disabled={processingId === selectedRequest.id}
                      className="flex-1 py-3 bg-red-500 text-white rounded-2xl font-black hover:bg-red-600 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {processingId === selectedRequest.id ? <Loader2 size={20} className="animate-spin" /> : <X size={20} />}
                      {lang === 'en' ? 'Reject Request' : 'رفض الطلب'}
                    </button>
                  </div>
                )}
                
                {selectedRequest.status !== 'Pending' && (
                  <div className="mt-8 pt-8 border-t border-zinc-100 dark:border-zinc-800">
                    <div className="flex items-center gap-4">
                      <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center",
                        selectedRequest.status === 'Approved' ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-600"
                      )}>
                        {selectedRequest.status === 'Approved' ? <Check size={20} /> : <X size={20} />}
                      </div>
                      <div>
                        <p className="text-sm font-black text-zinc-900 dark:text-white">
                          {selectedRequest.status} {lang === 'en' ? 'by' : 'بواسطة'} {selectedRequest.processor_name}
                        </p>
                        <p className="text-xs font-bold text-zinc-500">
                          {formatDate(selectedRequest.updated_at)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
