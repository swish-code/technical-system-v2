import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, formatDate } from '../../lib/utils';
import { History, Clock, User, Package, MapPin, Download, MessageCircle, Filter, X, Calendar as CalendarIcon, Building2, Store, Edit2, Check, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { AuditLog, Brand, Branch } from '../../types';

import { useFetch } from '../../hooks/useFetch';

interface GroupedLog {
  id: string;
  product_name: string;
  brand_name: string;
  branch: string;
  reason: string;
  responsible: string;
  hideLog: AuditLog | null;
  unhideLog: AuditLog | null;
  updateLogs: AuditLog[];
  durationMinutes: number | null;
  username: string;
}

export default function HistoryView() {
  const { user, lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [allLogs, setAllLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Filter states
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedBrand, setSelectedBrand] = useState<string>('');
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  // Pagination (20 sessions per page)
  const PAGE_SIZE = 20;
  const [currentPage, setCurrentPage] = useState(1);

  // Inline edit (admin only) — correct a wrongly recorded time/reason
  const isAdmin = user?.role_name === 'Manager';
  const [editingSession, setEditingSession] = useState<GroupedLog | null>(null);
  const [editHideTime, setEditHideTime] = useState('');
  const [editUnhideTime, setEditUnhideTime] = useState('');
  const [editReason, setEditReason] = useState('');
  const [editResponsible, setEditResponsible] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Stored timestamps are UTC; the input shows/accepts Kuwait local time (UTC+3).
  const toKuwaitInput = (ts?: string | null) => {
    if (!ts) return '';
    const d = (ts.includes('T') || ts.includes('Z')) ? new Date(ts) : new Date(ts.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value || '';
    let hour = get('hour'); if (hour === '24') hour = '00';
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
  };

  const openEdit = (session: GroupedLog) => {
    setEditingSession(session);
    setEditHideTime(toKuwaitInput(session.hideLog?.timestamp));
    setEditUnhideTime(toKuwaitInput(session.unhideLog?.timestamp));
    setEditReason(session.reason && session.reason !== 'N/A' ? session.reason : '');
    setEditResponsible(session.responsible || '');
  };

  const saveEdit = async () => {
    if (!editingSession) return;
    setSavingEdit(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/history/session`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hideLogId: editingSession.hideLog?.id || null,
          unhideLogId: editingSession.unhideLog?.id || null,
          hideTime: editingSession.hideLog ? editHideTime : null,
          unhideTime: editingSession.unhideLog ? editUnhideTime : null,
          reason: editReason,
          responsibleParty: editResponsible,
        }),
      });
      if (res.ok) {
        setEditingSession(null);
        await fetchLogs();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error('Failed to save history edit', err);
    } finally {
      setSavingEdit(false);
    }
  };

  const groupLogs = (filteredLogs: AuditLog[]) => {
    const sortedLogs = [...filteredLogs].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const sessions: GroupedLog[] = [];
    const activeSessions: Record<string, GroupedLog> = {};

    sortedLogs.forEach(log => {
      try {
        const data = JSON.parse(log.new_value || log.old_value || '{}');
        const productId = log.action === 'EDIT_HIDDEN_ITEM' ? data.product_id : log.target_id;
        const branch = data.branch_name || data.branch || data.branches || 'All Branches';
        const key = `${productId}-${branch}`;

        if (log.action === 'HIDE') {
          const session: GroupedLog = {
            id: `session-${log.id}`,
            product_name: data.product_name || 'Unknown Product',
            brand_name: data.brand_name || 'Unknown Brand',
            branch: branch,
            reason: data.reason || 'N/A',
            responsible: data.responsible_party || '',
            hideLog: log,
            unhideLog: null,
            updateLogs: [],
            durationMinutes: null,
            username: log.username
          };
          sessions.push(session);
          activeSessions[key] = session;
        } else if (log.action === 'UNHIDE') {
          let sessionKey = key;
          let session = activeSessions[key];

          // Fallback: if this is a specific branch unhide, look for an "All Branches" hide for the same product
          if (!session && branch !== 'All Branches') {
            const allBranchesKey = `${productId}-All Branches`;
            session = activeSessions[allBranchesKey];
            if (session) sessionKey = allBranchesKey;
          }

          if (session) {
            if (!session.unhideLog) {
              // First unhide for this session
              session.unhideLog = log;
              session.branch = branch;
              // Update brand name if unhide has more accurate info
              if (data.brand_name) session.brand_name = data.brand_name;
              const hideTime = new Date(session.hideLog!.timestamp).getTime();
              const unhideTime = new Date(log.timestamp).getTime();
              session.durationMinutes = Math.round((unhideTime - hideTime) / (1000 * 60));

              // Retire the session only if it was an exact product+branch match.
              // An "All Branches" session must stay active so other branches'
              // unhides can still pair with it (otherwise they become orphan rows).
              if (sessionKey === key) {
                delete activeSessions[key];
              }
            } else if (session.unhideLog.timestamp === log.timestamp) {
              // Same unhide action (bulk), different branch. 
              // If the session was "All Branches", we can just keep it as "All Branches" 
              // or update it to show multiple branches were unhidden.
              if (session.branch !== branch && !session.branch.includes(branch)) {
                if (session.branch !== 'All Branches') {
                  session.branch = "Multiple Branches";
                }
              }
            } else {
              // Different unhide action (different time). Clone the hide info for a new row.
              const newSession: GroupedLog = {
                ...session,
                id: `session-${log.id}`,
                product_name: data.product_name || session.product_name,
                brand_name: data.brand_name || session.brand_name,
                branch: branch,
                unhideLog: log,
                updateLogs: [...session.updateLogs],
              };
              const hideTime = new Date(newSession.hideLog!.timestamp).getTime();
              const unhideTime = new Date(log.timestamp).getTime();
              newSession.durationMinutes = Math.round((unhideTime - hideTime) / (1000 * 60));
              sessions.push(newSession);
            }
          } else {
            sessions.push({
              id: `session-${log.id}`,
              product_name: data.product_name || 'Unknown Product',
              brand_name: data.brand_name || 'Unknown Brand',
              branch: branch,
              reason: data.reason || 'N/A',
              responsible: data.responsible_party || '',
              hideLog: null,
              unhideLog: log,
              updateLogs: [],
              durationMinutes: null,
              username: log.username
            });
          }
        } else if (log.action === 'EDIT_HIDDEN_ITEM') {
          let session = activeSessions[key];
          
          if (!session && branch !== 'All Branches') {
            const allBranchesKey = `${productId}-All Branches`;
            session = activeSessions[allBranchesKey];
          }

          if (session) {
            session.updateLogs.push(log);
          } else {
            // Find the most recent session for this product/branch
            const lastSession = [...sessions].reverse().find(s => 
              s.product_name === (data.product_name || 'Unknown Product') && 
              (s.branch === branch || s.branch === 'All Branches')
            );
            if (lastSession) {
              lastSession.updateLogs.push(log);
            }
          }
        }
      } catch (e) {
        console.error("Error parsing log data", e);
      }
    });

    return sessions.sort((a, b) => {
      const timeA = new Date(a.hideLog?.timestamp || a.unhideLog?.timestamp || 0).getTime();
      const timeB = new Date(b.hideLog?.timestamp || b.unhideLog?.timestamp || 0).getTime();
      return timeB - timeA;
    });
  };

  const handleWhatsApp = (log: GroupedLog) => {
    try {
      const isHideOnly = !log.unhideLog;
      const text = isHideOnly 
        ? `Dear Team,\n\n` +
          `Please be informed that the below item has been hidden as per the following details:\n\n` +
          `Product Name: ${log.product_name}\n` +
          `Action Taken: Hidden\n` +
          `Primary Reason: ${log.reason}\n` +
          `Branch: ${log.branch}\n` +
          `Date & Time: ${log.hideLog ? formatDate(log.hideLog.timestamp) : 'N/A'}\n` +
          `Performed By: ${log.username}\n\n` +
          `You will be notified once the product is activated again.\n\n` +
          `Best regards,\n` +
          `${log.username}`
        : `Dear Team,\n\n` +
          `Please be informed that the below item has been unhidden as per the following details:\n\n` +
          `Product Name: ${log.product_name}\n` +
          `Action Taken: Unhidden\n` +
          `Primary Reason: ${log.reason}\n` +
          `Branch: ${log.branch}\n` +
          `Hide Time: ${log.hideLog ? formatDate(log.hideLog.timestamp) : 'N/A'}\n` +
          `Unhide Time: ${log.unhideLog ? formatDate(log.unhideLog.timestamp) : 'N/A'}\n` +
          `Duration: ${log.durationMinutes} minutes\n` +
          `Performed By: ${log.unhideLog?.username || log.username}\n\n` +
          `Best regards,\n` +
          `${log.unhideLog?.username || log.username}`;
      
      const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank');
    } catch (e) {
      console.error("Failed to share to WhatsApp", e);
    }
  };

  const filteredLogs = useMemo(() => {
    const grouped = groupLogs(allLogs);
    
    return grouped.filter(session => {
      // Parse data from either hide or unhide log to get brand/branch info
      const data = JSON.parse(session.hideLog?.new_value || session.unhideLog?.new_value || session.hideLog?.old_value || session.unhideLog?.old_value || '{}');
      
      // Brand filter
      if (selectedBrand) {
        // Try to match by brand_id first
        if (data.brand_id) {
          if (data.brand_id.toString() !== selectedBrand) return false;
        } else {
          // Fallback to brand_name if brand_id is missing (for older logs)
          const brand = brands.find(b => b.id.toString() === selectedBrand);
          if (brand && session.brand_name !== brand.name) return false;
        }
      }
      
      // Branch filter
      if (selectedBranch) {
        if (selectedBranch === 'all') {
          if (session.branch !== 'All Branches') return false;
        } else {
          // Try to match by branch_id first
          if (data.branch_id) {
            if (data.branch_id.toString() !== selectedBranch) return false;
          } else {
            // Fallback to branch name matching for older logs
            const branch = branches.find(b => b.id.toString() === selectedBranch);
            if (branch && session.branch !== branch.name) return false;
          }
        }
      }
      
      // Date filter
      const hideTime = session.hideLog ? new Date(session.hideLog.timestamp) : null;
      const unhideTime = session.unhideLog ? new Date(session.unhideLog.timestamp) : null;
      
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        // Session is included if either hide or unhide happened after start date
        const isAfterStart = (hideTime && hideTime >= start) || (unhideTime && unhideTime >= start);
        if (!isAfterStart) return false;
      }
      
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        // Session is included if either hide or unhide happened before end date
        const isBeforeEnd = (hideTime && hideTime <= end) || (unhideTime && unhideTime <= end);
        if (!isBeforeEnd) return false;
      }
      
      return true;
    });
  }, [allLogs, startDate, endDate, selectedBrand, selectedBranch, brands, branches]);

  const stats = useMemo(() => {
    let totalMinutes = 0;
    const productCounts: Record<string, number> = {};
    
    filteredLogs.forEach(log => {
      // Sum duration if available
      if (log.durationMinutes) {
        totalMinutes += log.durationMinutes;
      }
      
      // Count product occurrences
      const productName = log.product_name;
      productCounts[productName] = (productCounts[productName] || 0) + 1;
    });
    
    // Find most frequent product
    let mostFrequentProduct = '-';
    let maxCount = 0;
    Object.entries(productCounts).forEach(([name, count]) => {
      if (count > maxCount) {
        maxCount = count;
        mostFrequentProduct = name;
      }
    });
    
    return {
      totalMinutes,
      mostFrequentProduct,
      maxCount,
      totalRecords: filteredLogs.length
    };
  }, [filteredLogs]);

  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE));
  const paginatedLogs = useMemo(
    () => filteredLogs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredLogs, currentPage]
  );

  // Reset to the first page whenever the filtered result set changes.
  useEffect(() => {
    setCurrentPage(1);
  }, [startDate, endDate, selectedBrand, selectedBranch, allLogs]);

  // Keep the current page within bounds if the data shrinks.
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/audit-logs`);
      if (res.ok) {
        const data: AuditLog[] = await res.json();
        const filtered = data.filter(log => 
          (log.action === 'HIDE' || log.action === 'UNHIDE' || log.action === 'EDIT_HIDDEN_ITEM') && 
          (log.target_table === 'products' || log.target_table === 'hidden_items')
        );
        setAllLogs(filtered);
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch audit logs", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchBrands = async () => {
    try {
      const res = await fetchWithAuth(`${API_URL}/brands`);
      if (res.ok) {
        const data = await res.json();
        setBrands(data);
      }
    } catch (err) {
      console.error("Failed to fetch brands", err);
    }
  };

  const fetchBranches = async (brandId: string) => {
    if (!brandId) {
      setBranches([]);
      return;
    }
    try {
      const res = await fetchWithAuth(`${API_URL}/branches?brand_id=${brandId}`);
      if (res.ok) {
        let data = await res.json();
        
        // Filter for Restaurants role
        if (user?.role_name === 'Restaurants' && user.branch_id) {
          data = data.filter((b: any) => b.id === user.branch_id);
        }
        
        setBranches(data);
        if (data.length === 1) {
          setSelectedBranch(data[0].id.toString());
        }
      }
    } catch (err) {
      console.error("Failed to fetch branches", err);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);
      if (selectedBrand) params.append('brandId', selectedBrand);
      if (selectedBranch) params.append('branchId', selectedBranch);

      const res = await fetchWithAuth(`${API_URL}/export-history?${params.toString()}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'operation_history.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to export history", err);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    fetchBrands();
  }, []);

  useEffect(() => {
    if (selectedBrand) {
      fetchBranches(selectedBrand);
      setSelectedBranch('');
    } else {
      setBranches([]);
      setSelectedBranch('');
    }
  }, [selectedBrand]);

  const clearFilters = () => {
    setStartDate('');
    setEndDate('');
    setSelectedBrand('');
    setSelectedBranch('');
  };

  return (
    <div className="max-w-[1600px] mx-auto space-y-8 pb-20">
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col lg:flex-row lg:items-center justify-between gap-6"
      >
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-zinc-900 dark:bg-white rounded-2xl text-white dark:text-zinc-900 shadow-xl shadow-zinc-900/10 shrink-0">
              <History size={28} strokeWidth={2.5} />
            </div>
            <h2 className="text-3xl md:text-5xl font-black text-zinc-900 dark:text-white tracking-tight">Operation History</h2>
          </div>
          <p className="text-zinc-500 dark:text-zinc-400 font-semibold text-base md:text-lg ml-1">Track all hide and unhide actions across the system.</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold transition-all shadow-lg ${
              showFilters || startDate || endDate || selectedBrand || selectedBranch
                ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900' 
                : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700'
            }`}
          >
            <Filter size={20} />
            <span>FILTERS</span>
            {(startDate || endDate || selectedBrand || selectedBranch) && (
              <span className="ml-1 w-5 h-5 bg-emerald-500 text-white text-[10px] flex items-center justify-center rounded-full">!</span>
            )}
          </button>

          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white rounded-xl font-bold transition-all shadow-lg shadow-emerald-600/20"
          >
            {exporting ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Download size={20} />
            )}
            <span>EXPORT TO EXCEL</span>
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-white dark:bg-zinc-900 p-8 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 shadow-xl space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-black text-zinc-900 dark:text-white uppercase tracking-tight flex items-center gap-2">
                  <Filter size={18} className="text-emerald-500" />
                  Filter Records
                </h3>
                <button 
                  onClick={clearFilters}
                  className="text-xs font-bold text-zinc-400 hover:text-red-500 transition-colors flex items-center gap-1 uppercase tracking-widest"
                >
                  <X size={14} />
                  Clear All
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Date Range */}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest flex items-center gap-1.5">
                    <CalendarIcon size={12} />
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 rounded-xl text-sm font-bold text-zinc-900 dark:text-white focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest flex items-center gap-1.5">
                    <CalendarIcon size={12} />
                    End Date
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 rounded-xl text-sm font-bold text-zinc-900 dark:text-white focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all"
                  />
                </div>

                {/* Brand Filter */}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest flex items-center gap-1.5">
                    <Building2 size={12} />
                    Brand
                  </label>
                  <select
                    value={selectedBrand}
                    onChange={(e) => setSelectedBrand(e.target.value)}
                    className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 rounded-xl text-sm font-bold text-zinc-900 dark:text-white focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all appearance-none"
                  >
                    <option value="">All Brands</option>
                    {brands.map(brand => (
                      <option key={brand.id} value={brand.id}>{brand.name}</option>
                    ))}
                  </select>
                </div>

                {/* Branch Filter */}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest flex items-center gap-1.5">
                    <Store size={12} />
                    Branch
                  </label>
                  <select
                    value={selectedBranch}
                    onChange={(e) => setSelectedBranch(e.target.value)}
                    disabled={!selectedBrand}
                    className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 rounded-xl text-sm font-bold text-zinc-900 dark:text-white focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all appearance-none disabled:opacity-50"
                  >
                    {user?.role_name !== 'Restaurants' && (
                      <>
                        <option value="">All Branches</option>
                        <option value="all">Only "All Branches" Records</option>
                      </>
                    )}
                    {branches.map(branch => (
                      <option key={branch.id} value={branch.id}>{branch.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Summary Stats */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 md:grid-cols-3 gap-6"
      >
        <div className="bg-white dark:bg-zinc-900 p-6 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 shadow-xl flex items-center gap-4 group hover:border-emerald-500/50 transition-all">
          <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 rounded-2xl group-hover:scale-110 transition-transform">
            <Clock size={24} />
          </div>
          <div>
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Total Duration</p>
            <p className="text-2xl font-black text-zinc-900 dark:text-white">{stats.totalMinutes} min</p>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 p-6 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 shadow-xl flex items-center gap-4 group hover:border-amber-500/50 transition-all">
          <div className="p-4 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-2xl group-hover:scale-110 transition-transform">
            <Package size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Most Frequent Item</p>
            <p className="text-xl font-black text-zinc-900 dark:text-white truncate" title={stats.mostFrequentProduct}>
              {stats.mostFrequentProduct}
            </p>
            {stats.maxCount > 0 && (
              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-tight">
                Hidden {stats.maxCount} times
              </p>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 p-6 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 shadow-xl flex items-center gap-4 group hover:border-blue-500/50 transition-all">
          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-2xl group-hover:scale-110 transition-transform">
            <History size={24} />
          </div>
          <div>
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Total Actions</p>
            <p className="text-2xl font-black text-zinc-900 dark:text-white">{stats.totalRecords}</p>
          </div>
        </div>
      </motion.div>

      <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] border border-zinc-200 dark:border-zinc-800 overflow-hidden shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-800/50">
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">User</th>
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">Product Details</th>
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">Primary Reason</th>
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">Hide Time</th>
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">Update Info</th>
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">Unhide Time</th>
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400">Duration (Min)</th>
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-8 py-20 text-center">
                    <div className="flex items-center justify-center gap-3 text-zinc-400">
                      <div className="w-5 h-5 border-2 border-zinc-200 border-t-zinc-900 dark:border-zinc-800 dark:border-t-white rounded-full animate-spin" />
                      <span className="text-sm font-bold uppercase tracking-widest">Loading history...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-8 py-20 text-center">
                    <p className="text-zinc-400 font-bold uppercase tracking-widest">No history records found</p>
                  </td>
                </tr>
              ) : (
                paginatedLogs.map((log, idx) => (
                  <motion.tr
                    key={log.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.01 }}
                    className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-xs font-black text-zinc-500">
                          {log.username?.[0]?.toUpperCase()}
                        </div>
                        <span className="text-sm font-bold text-zinc-900 dark:text-white uppercase tracking-tight">{log.username}</span>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <Package size={14} className="text-zinc-400" />
                          <span className="text-sm font-black text-zinc-900 dark:text-white">{log.product_name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Building2 size={12} className="text-zinc-400" />
                          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-tight">
                            {log.brand_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <MapPin size={12} className="text-zinc-400" />
                          <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-tight">
                            {log.branch}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-8 py-5">
                      <span className="px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                        {log.reason}
                      </span>
                    </td>
                    <td className="px-8 py-5">
                      {log.hideLog ? (
                        <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                          <Clock size={14} />
                          <span className="text-xs font-bold uppercase tracking-tight">
                            {formatDate(log.hideLog.timestamp)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-400 italic">N/A</span>
                      )}
                    </td>
                    <td className="px-8 py-5">
                      {log.updateLogs.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {log.updateLogs.slice(-1).map((update, i) => (
                            <div key={i} className="flex flex-col">
                              <div className="flex items-center gap-2 text-amber-500">
                                <Clock size={12} />
                                <span className="text-[10px] font-black uppercase tracking-tighter">
                                  {formatDate(update.timestamp)}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 text-amber-500/70">
                                <User size={10} />
                                <span className="text-[9px] font-black uppercase tracking-tighter">
                                  By: {update.username}
                                </span>
                              </div>
                            </div>
                          ))}
                          {log.updateLogs.length > 1 && (
                            <span className="text-[8px] text-zinc-400 italic">+{log.updateLogs.length - 1} more edits</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-400 italic">-</span>
                      )}
                    </td>
                    <td className="px-8 py-5">
                      {log.unhideLog ? (
                        <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                          <Clock size={14} />
                          <span className="text-xs font-bold uppercase tracking-tight">
                            {formatDate(log.unhideLog.timestamp)}
                          </span>
                        </div>
                      ) : (
                        <span className="px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400">
                          STILL HIDDEN
                        </span>
                      )}
                    </td>
                    <td className="px-8 py-5">
                      {log.durationMinutes !== null ? (
                        <span className="text-sm font-black text-zinc-900 dark:text-white">
                          {log.durationMinutes} min
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-400 italic">-</span>
                      )}
                    </td>
                    <td className="px-8 py-5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleWhatsApp(log)}
                          className="p-2 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-colors"
                          title="Share via WhatsApp"
                        >
                          <MessageCircle size={18} />
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => openEdit(log)}
                            className="p-2 text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                            title="Edit record"
                          >
                            <Edit2 size={18} />
                          </button>
                        )}
                      </div>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!loading && filteredLogs.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-8 py-6 border-t border-zinc-100 dark:border-zinc-800">
            <p className="text-[11px] font-black text-zinc-400 uppercase tracking-widest">
              Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredLogs.length)} of {filteredLogs.length}
            </p>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-2 rounded-xl text-xs font-bold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Prev
              </button>
              {(() => {
                const pages: (number | string)[] = [];
                if (totalPages <= 7) {
                  for (let i = 1; i <= totalPages; i++) pages.push(i);
                } else {
                  pages.push(1);
                  const start = Math.max(2, currentPage - 1);
                  const end = Math.min(totalPages - 1, currentPage + 1);
                  if (start > 2) pages.push('...');
                  for (let i = start; i <= end; i++) pages.push(i);
                  if (end < totalPages - 1) pages.push('...');
                  pages.push(totalPages);
                }
                return pages.map((p, i) =>
                  typeof p === 'number' ? (
                    <button
                      key={i}
                      onClick={() => setCurrentPage(p)}
                      className={`min-w-[36px] px-3 py-2 rounded-xl text-xs font-black transition-all ${
                        p === currentPage
                          ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                          : 'text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {p}
                    </button>
                  ) : (
                    <span key={i} className="px-1 text-zinc-400 text-xs font-black">…</span>
                  )
                );
              })()}
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-2 rounded-xl text-xs font-bold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Edit Modal (admin only) */}
      <AnimatePresence>
        {editingSession && (
          <div className="fixed inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center z-[150] p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white dark:bg-zinc-900 rounded-[2.5rem] w-full max-w-md overflow-hidden shadow-[0_40px_80px_-15px_rgba(0,0,0,0.3)] border border-transparent dark:border-zinc-800"
            >
              <div className="p-8 space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-2xl font-black tracking-tight text-zinc-900 dark:text-white">Edit Record</h3>
                  <button onClick={() => setEditingSession(null)} className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors text-zinc-500 dark:text-zinc-400">
                    <X size={20} />
                  </button>
                </div>

                <div className="flex items-center gap-2 text-sm">
                  <Package size={16} className="text-zinc-400" />
                  <span className="font-black text-zinc-900 dark:text-white">{editingSession.product_name}</span>
                  <span className="text-[10px] font-bold text-zinc-400 uppercase">· {editingSession.branch}</span>
                </div>

                <div className="space-y-4 p-6 bg-zinc-50 dark:bg-zinc-800/50 rounded-3xl border border-zinc-100 dark:border-zinc-800">
                  {editingSession.hideLog && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">Hide Time</label>
                      <input
                        type="datetime-local"
                        value={editHideTime}
                        onChange={(e) => setEditHideTime(e.target.value)}
                        className="w-full px-4 py-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white"
                      />
                    </div>
                  )}
                  {editingSession.unhideLog && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">Unhide Time</label>
                      <input
                        type="datetime-local"
                        value={editUnhideTime}
                        onChange={(e) => setEditUnhideTime(e.target.value)}
                        className="w-full px-4 py-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white"
                      />
                    </div>
                  )}
                  {editingSession.hideLog && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">Primary Reason</label>
                      <input
                        type="text"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        placeholder="Reason"
                        className="w-full px-4 py-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white"
                      />
                    </div>
                  )}
                  {editingSession.hideLog && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">Responsible Party</label>
                      <input
                        type="text"
                        value={editResponsible}
                        onChange={(e) => setEditResponsible(e.target.value)}
                        placeholder="Responsible party"
                        className="w-full px-4 py-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 focus:border-zinc-900 dark:focus:border-white outline-none transition-all font-bold text-zinc-900 dark:text-white"
                      />
                    </div>
                  )}
                  <p className="text-[10px] text-zinc-400 ml-1">Times are shown in Kuwait local time.</p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setEditingSession(null)}
                    className="flex-1 px-6 py-3.5 rounded-2xl font-bold text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveEdit}
                    disabled={savingEdit}
                    className="flex-[2] bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-6 py-3.5 rounded-2xl font-black shadow-xl hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all flex items-center justify-center gap-2 disabled:opacity-70"
                  >
                    {savingEdit ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check size={20} className="text-emerald-400" />}
                    Save Changes
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
