import React, { useState, useEffect } from 'react';
import { Search, Download, Trash2, Filter, Clock, User, AlertCircle, MessageCircle, RefreshCw } from 'lucide-react';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import ConfirmModal from '../ConfirmModal';
import { useAuth } from '../../context/AuthContext';

interface HiddenItem {
  id: number;
  brand_name: string;
  branch_name: string;
  product_name: string;
  agent_name: string;
  reason: string;
  requested_at: string;
  responsible_party: string;
  created_at: string;
  username: string;
}

import { useFetch } from '../../hooks/useFetch';

export default function HideItemDatabaseView() {
  const { fetchWithAuth } = useFetch();
  const { lang } = useAuth();
  const [records, setRecords] = useState<HiddenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('');

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    id: number | null;
  }>({
    isOpen: false,
    id: null
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_URL}/hidden-items`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`Failed to fetch hidden items: ${res.status} ${errorData.error || ''}`);
      }
      setRecords(await res.json());
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch hidden items", err);
      setError(err.message || 'An unexpected error occurred while fetching hidden items.');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    setConfirmModal({ isOpen: true, id });
  };

  const executeDelete = async () => {
    if (confirmModal.id === null) return;
    
    try {
      const res = await fetchWithAuth(`${API_URL}/hidden-items/${confirmModal.id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        fetchData();
        setConfirmModal({ isOpen: false, id: null });
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to delete", err);
    }
  };

  const handleWhatsApp = (item: HiddenItem) => {
    const text = `Dear Team,\n\n` +
      `Please be informed that the below item has been hidden as per the following details:\n\n` +
      `Product Name: ${item.product_name}\n` +
      `Action Taken: Hidden\n` +
      `Branch: ${item.branch_name || 'All Branches'}\n` +
      `Date & Time: ${formatDate(item.created_at)}\n` +
      `Performed By: ${item.agent_name}\n\n` +
      `You will be notified once the product is activated again.\n\n` +
      `Best regards,\n` +
      `${item.agent_name}`;
    
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  };

  const handleExport = async () => {
    try {
      const res = await fetchWithAuth(`${API_URL}/hidden-items/export`);
      
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
        a.download = `hidden_items_${dateStr}.xlsx`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to export data", err);
    }
  };

  const filteredRecords = records.filter(r => {
    const matchesSearch = r.product_name.toLowerCase().includes(search.toLowerCase()) || 
                         r.agent_name.toLowerCase().includes(search.toLowerCase()) ||
                         r.reason.toLowerCase().includes(search.toLowerCase());
    const matchesBrand = brandFilter === '' || r.brand_name === brandFilter;
    return matchesSearch && matchesBrand;
  });

  const brands = Array.isArray(records) ? Array.from(new Set(records.map(r => r.brand_name))) : [];

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-6">
        <div className="w-20 h-20 bg-red-50 dark:bg-red-900/20 rounded-3xl flex items-center justify-center text-red-500 shadow-xl shadow-red-500/10">
          <AlertCircle size={40} />
        </div>
        <div className="text-center space-y-2">
          <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">
            Error Loading Data
          </h3>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium max-w-md mx-auto">
            {error}
          </p>
        </div>
        <button
          onClick={() => fetchData()}
          className="px-8 py-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-2xl font-black shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3"
        >
          <RefreshCw size={20} />
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={lang === 'en' ? 'Confirm Unhide' : 'تأكيد الإظهار'}
        message={lang === 'en' ? 'Are you sure you want to unhide this item?' : 'هل أنت متأكد أنك تريد إظهار هذا العنصر؟'}
        onConfirm={executeDelete}
        onCancel={() => setConfirmModal({ isOpen: false, id: null })}
        confirmText={lang === 'en' ? 'Unhide' : 'إظهار'}
        cancelText={lang === 'en' ? 'Cancel' : 'إلغاء'}
        lang={lang}
      />
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h2 className="text-4xl font-black text-zinc-900 dark:text-white tracking-tight mb-2">Hidden Items Database</h2>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium">View and manage all currently hidden products across branches.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="px-6 py-3 bg-zinc-900 dark:bg-white rounded-2xl text-white dark:text-zinc-900 shadow-xl shadow-zinc-900/20 dark:shadow-white/5 flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-sm font-bold">{records.length} Hidden Items</span>
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

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
        <div className="lg:col-span-8 relative group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-600 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={20} />
          <input 
            type="text"
            placeholder="Search by item, agent, or reason..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-sm focus:ring-2 focus:ring-blue-500 transition-all outline-none shadow-sm"
          />
        </div>
        <div className="lg:col-span-4 relative">
          <Filter className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
          <select
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-sm focus:ring-2 focus:ring-blue-500 transition-all outline-none shadow-sm appearance-none"
          >
            <option value="">All Brands</option>
            {Array.isArray(brands) && brands.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={18} />
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50 dark:bg-zinc-950/50">
                <th className="px-8 py-5 text-xs font-bold uppercase tracking-wider text-zinc-500">Brand</th>
                <th className="px-8 py-5 text-xs font-bold uppercase tracking-wider text-zinc-500">Branch</th>
                <th className="px-8 py-5 text-xs font-bold uppercase tracking-wider text-zinc-500">Item</th>
                <th className="px-8 py-5 text-xs font-bold uppercase tracking-wider text-zinc-500">Agent</th>
                <th className="px-8 py-5 text-xs font-bold uppercase tracking-wider text-zinc-500">Reason</th>
                <th className="px-8 py-5 text-xs font-bold uppercase tracking-wider text-zinc-500">Requested At</th>
                <th className="px-8 py-5 text-xs font-bold uppercase tracking-wider text-zinc-500 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              <AnimatePresence mode="popLayout">
                {filteredRecords.length === 0 ? (
                  <motion.tr
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <td colSpan={7} className="px-8 py-20 text-center">
                      <div className="flex flex-col items-center gap-4 text-zinc-400">
                        <AlertCircle size={48} strokeWidth={1} />
                        <p className="text-lg font-medium">No hidden items found matching your criteria.</p>
                      </div>
                    </td>
                  </motion.tr>
                ) : (
                  filteredRecords.map((item) => (
                    <motion.tr 
                      key={item.id}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="group hover:bg-zinc-50 dark:hover:bg-zinc-950/50 transition-colors"
                    >
                      <td className="px-8 py-5">
                        <span className="text-sm font-bold text-zinc-900 dark:text-white">{item.brand_name}</span>
                      </td>
                      <td className="px-8 py-5">
                        <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{item.branch_name || 'All Branches'}</span>
                      </td>
                      <td className="px-8 py-5">
                        <span className="text-sm font-medium text-zinc-900 dark:text-white">{item.product_name}</span>
                      </td>
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-2">
                          <User size={14} className="text-zinc-400" />
                          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{item.agent_name}</span>
                        </div>
                      </td>
                      <td className="px-8 py-5">
                        <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{item.reason}</span>
                      </td>
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                          <Clock size={14} />
                          <span className="text-xs font-medium">
                            {item.requested_at ? formatDate(item.requested_at) : 'N/A'}
                          </span>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleWhatsApp(item)}
                            className="p-2.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                            title="Share via WhatsApp"
                          >
                            <MessageCircle size={18} />
                          </button>
                          <button 
                            onClick={() => handleDelete(item.id)}
                            className="p-2.5 text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                            title="Unhide Item"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  ))
                )}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ChevronDown(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
