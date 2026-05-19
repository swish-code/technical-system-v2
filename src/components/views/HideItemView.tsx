import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Search, Check, X, Clock, User, AlertCircle, ChevronDown, Filter, Trash2, Package, MapPin, Shield, Send, Sparkles, Globe, MessageCircle, FileText } from 'lucide-react';
import { API_URL, formatDate, safeJson } from '../../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';
import * as XLSX from 'xlsx';

interface Brand { id: number; name: string; }
interface Branch { id: number; brand_id: number; name: string; }
interface Product { id: number; brand_id: number; brand_name: string; product_name: string; ingredients?: string; is_offline?: boolean; }
interface HiddenItem {
  id: number; 
  brand_id: number;
  branch_id: number | null;
  product_id: number;
  brand_name: string; 
  branch_name: string; 
  product_name: string;
  agent_name: string; 
  reason: string; 
  requested_at: string; 
  responsible_party: string; 
  created_at: string;
}

import { useFetch } from '../../hooks/useFetch';

export default function HideItemView() {
  const { lang, user } = useAuth();
  const { fetchWithAuth, fetchJson } = useFetch();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [responsibleParties, setResponsibleParties] = useState<{ id: number; name: string }[]>([]);
  const [hiddenItems, setHiddenItems] = useState<HiddenItem[]>([]);
  const [fields, setFields] = useState<any[]>([]);
  
  const [selectedBrand, setSelectedBrand] = useState<string>('');
  const [selectedBranch, setSelectedBranch] = useState<string>(user?.branch_id ? user.branch_id.toString() : 'all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  
  const [formData, setFormData] = useState({
    agent_name: user?.username || '', reason: '', comment: '', responsible_party: ''
  });

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [isAutoFilling, setIsAutoFilling] = useState(false);
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    fetchInitialData();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'PRODUCT_CREATED' || data.type === 'PRODUCT_UPDATED' || data.type === 'PRODUCT_DELETED' || data.type === 'HIDDEN_ITEMS_UPDATED' || data.type === 'FIELDS_UPDATED') {
        fetchInitialData();
        if (selectedBrand) fetchBrandSpecificData();
      }
    };
    return () => ws.close();
  }, [selectedBrand]);

  useEffect(() => {
    if (selectedBrand && fields.length > 0) fetchBrandSpecificData();
    else if (!selectedBrand) { setBranches([]); setProducts([]); }
  }, [selectedBrand, fields]);

  const fetchInitialData = async () => {
    setLoading(true);
    try {
      const [brandsRes, respRes, hiddenRes, fieldsRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/brands`),
        fetchWithAuth(`${API_URL}/busy-responsible`),
        fetchWithAuth(`${API_URL}/hidden-items`),
        fetchWithAuth(`${API_URL}/fields`)
      ]);
      if (fieldsRes.ok) {
        const data = await safeJson(fieldsRes);
        if (data) {
          setFields(data.fields || []);
        }
      }
      if (brandsRes.ok) {
        const data = await safeJson(brandsRes);
        const brandsList = Array.isArray(data) ? data : [];
        setBrands(brandsList);
        if (brandsList.length === 1) {
          setSelectedBrand(brandsList[0].id.toString());
        }
      }
      if (respRes.ok) {
        const data = await safeJson(respRes);
        const respList = Array.isArray(data) ? data : [];
        setResponsibleParties(respList);
        if (respList.length === 1) {
          setFormData(prev => ({ ...prev, responsible_party: respList[0].name }));
        }
      }
      if (hiddenRes.ok) {
        const data = await safeJson(hiddenRes);
        setHiddenItems(Array.isArray(data) ? data : []);
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchBrandSpecificData = async () => {
    try {
      const [brData, pData] = await Promise.all([
        fetchJson(`${API_URL}/branches`),
        fetchJson(`${API_URL}/products?brand_id=${selectedBrand}&limit=5000`)
      ]);
      if (brData) {
        if (Array.isArray(brData)) {
          let filteredBranches = brData.filter((b: Branch) => b.brand_id === Number(selectedBrand));
          
          // Filter for Restaurants role
          if (user?.role_name === 'Restaurants' && user.branch_id) {
            filteredBranches = filteredBranches.filter((b: Branch) => b.id === user.branch_id);
          }
          
          setBranches(filteredBranches);
          if (filteredBranches.length === 1) {
            setSelectedBranch(filteredBranches[0].id.toString());
          } else if (user?.role_name === 'Restaurants' && filteredBranches.length === 0) {
            // If no branches match but user is restaurant, clear selection
            setSelectedBranch('');
          }
        } else {
          setBranches([]);
        }
      }
      if (pData) {
        if (pData && Array.isArray(pData.products)) {
          const productNameFieldId = (Array.isArray(fields) ? fields : []).find(f => f.name_en === 'Product Name (EN)')?.id || 3;
          const ingredientsFieldId = (Array.isArray(fields) ? fields : []).find(f => f.name_en === 'Ingredients')?.id;
          
          const mappedProducts = pData.products.map((p: any) => {
            const nameValue = pData.fieldValues?.find((fv: any) => fv.product_id === p.id && fv.field_id === productNameFieldId);
            const ingredientsValue = pData.fieldValues?.find((fv: any) => fv.product_id === p.id && fv.field_id === ingredientsFieldId);
            
            return { 
              ...p, 
              product_name: nameValue ? nameValue.value : 'Unnamed Product',
              ingredients: ingredientsValue ? ingredientsValue.value : '',
              is_offline: !!p.is_offline
            };
          });
          setProducts(mappedProducts);
        } else {
          setProducts([]);
        }
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error(err);
    }
  };

  const toggleProduct = (id: number) => {
    const product = products.find(p => p.id === id);
    if (product?.is_offline) return;
    setSelectedProductIds(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  };

  const handleSelectAll = () => {
    const filteredIds = products
      .filter(p => {
        const matchesSearch = p.product_name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                             (p.ingredients && p.ingredients.toLowerCase().includes(searchQuery.toLowerCase()));
        return matchesSearch && !p.is_offline;
      })
      .map(p => p.id);
    setSelectedProductIds(selectedProductIds.length === filteredIds.length ? [] : filteredIds);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedProductIds.length === 0 || !selectedBrand || !formData.agent_name || !formData.reason || !formData.responsible_party) {
      return;
    }
    setSubmitting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/hidden-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          brand_id: Number(selectedBrand),
          branch_id: selectedBranch === 'all' ? null : Number(selectedBranch),
          product_ids: selectedProductIds,
          ...formData
        })
      });
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => {
          setSuccess(false);
          setFormData({ agent_name: '', reason: '', comment: '', responsible_party: '' });
          setSelectedProductIds([]);
          fetchInitialData();
        }, 2000);
      }
    } catch (err) { console.error(err); } finally { setSubmitting(false); }
  };

  const handleAutoFill = async () => {
    if (user?.role_name !== 'Restaurants') return;
    setIsAutoFilling(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/hidden-items/most-frequent`);
      const data = await safeJson(res);
      if (data.reason || data.responsible_party) {
        setFormData(prev => ({
          ...prev,
          reason: data.reason || prev.reason,
          responsible_party: data.responsible_party || prev.responsible_party
        }));
        showToast(lang === 'en' ? 'Form auto-filled with most frequent data' : 'تم تعبئة الحقول تلقائياً بأكثر البيانات تكراراً');
      } else {
        showToast(lang === 'en' ? 'No frequent data found for this branch' : 'لم يتم العثور على بيانات متكررة لهذا الفرع', 'error');
      }
    } catch (err) {
      console.error("Auto-fill error", err);
      showToast(lang === 'en' ? 'Failed to fetch frequent data' : 'فشل في جلب البيانات المتكررة', 'error');
    } finally {
      setIsAutoFilling(false);
    }
  };

  const handleUnhide = async (id: number) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/hidden-items/bulk-unhide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: [id] })
      });
      if (res.ok) {
        await fetchInitialData();
        alert("Item unhidden successfully!");
      } else {
        const errorData = await res.json();
        alert(`Error: ${errorData.error || 'Failed to unhide item'}`);
      }
    } catch (err) {
      console.error(err);
      alert("A network error occurred.");
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

  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();
    const data = hiddenItems.map(item => ({
      [lang === 'ar' ? 'اسم المنتج' : 'Product Name']: item.product_name,
      [lang === 'ar' ? 'البراند' : 'Brand']: item.brand_name,
      [lang === 'ar' ? 'الفرع' : 'Branch']: item.branch_name || (lang === 'ar' ? 'كل الفروع' : 'All Branches'),
      [lang === 'ar' ? 'السبب' : 'Reason']: item.reason,
      [lang === 'ar' ? 'بواسطة' : 'By']: item.agent_name,
      [lang === 'ar' ? 'تاريخ الإخفاء' : 'Hide Date']: formatDate(item.created_at)
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, lang === 'ar' ? 'العناصر المخفية' : "Hidden Items");
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuwait' });
    XLSX.writeFile(wb, `Swish_Currently_Hidden_${dateStr}.xlsx`);
  };

  const getHiddenStatus = (productId: number) => {
    const brandHiddenRecords = hiddenItems.filter(h => h.brand_id === Number(selectedBrand) && h.product_id === productId);
    
    if (brandHiddenRecords.some(h => h.branch_id === null)) return 'Global';
    if (selectedBranch !== 'all' && brandHiddenRecords.some(h => h.branch_id === Number(selectedBranch))) return 'Branch';
    if (selectedBranch === 'all' && branches.length > 0 && brandHiddenRecords.length >= branches.length) return 'All Branches';
    
    return null;
  };

  const filteredProducts = products.filter(p => {
    const matchesSearch = p.product_name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                         (p.ingredients && p.ingredients.toLowerCase().includes(searchQuery.toLowerCase()));
    
    return matchesSearch && !getHiddenStatus(p.id);
  });

  const highlightText = (text: string, query: string) => {
    if (!query) return text;
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return (
      <span>
        {parts.map((part, i) => 
          part.toLowerCase() === query.toLowerCase() ? (
            <span key={i} className="bg-amber-400/40 dark:bg-amber-400/20 text-zinc-900 dark:text-amber-400 rounded-sm px-0.5">{part}</span>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </span>
    );
  };

  return (
    <div className="max-w-[1600px] mx-auto space-y-8 pb-20">
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col md:flex-row md:items-center justify-between gap-4"
      >
        <div className="space-y-1 flex-1">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-zinc-900 dark:bg-white rounded-xl text-white dark:text-zinc-900 shadow-xl shadow-zinc-900/10">
              <Shield size={24} strokeWidth={2.5} />
            </div>
            <h2 className="text-4xl font-black text-zinc-900 dark:text-white tracking-tight">Hide Items</h2>
          </div>
          <p className="text-zinc-500 dark:text-zinc-400 font-semibold mt-1">Precision control for product availability across branches.</p>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Selection Column */}
        <motion.div 
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className={cn("xl:col-span-5 space-y-6", user?.role_name === 'Area Manager' && "hidden")}
        >
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] relative overflow-hidden">
            <div className="absolute top-0 right-0 p-6 opacity-[0.03] dark:opacity-[0.05] pointer-events-none">
              <Package size={100} strokeWidth={1} />
            </div>

            <div className="space-y-6 relative z-10">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <label className="text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500 ml-1">Brand Identity</label>
                  <div className="relative group">
                    <Globe className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={18} />
                    <select 
                      value={selectedBrand}
                      onChange={(e) => setSelectedBrand(e.target.value)}
                      className="w-full bg-zinc-50 dark:bg-zinc-950 border-2 border-zinc-100 dark:border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-sm font-bold text-zinc-900 dark:text-white focus:border-zinc-900 dark:focus:border-white transition-all outline-none appearance-none cursor-pointer shadow-sm"
                    >
                      <option value="">Select Brand...</option>
                      {Array.isArray(brands) && brands.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={18} />
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500 ml-1">Target Branch</label>
                  <div className="relative group">
                    <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={18} />
                    <select 
                      value={selectedBranch}
                      onChange={(e) => setSelectedBranch(e.target.value)}
                      disabled={!selectedBrand}
                      className="w-full bg-zinc-50 dark:bg-zinc-950 border-2 border-zinc-100 dark:border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-sm font-bold text-zinc-900 dark:text-white focus:border-zinc-900 dark:focus:border-white transition-all outline-none appearance-none cursor-pointer disabled:opacity-40 shadow-sm"
                    >
                      {user?.role_name !== 'Restaurants' && <option value="all">All Branches</option>}
                      {branches.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={18} />
                  </div>
                </div>
              </div>

              <div className="space-y-5">
                <div className="flex items-center justify-between px-1">
                  <label className="text-[11px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500">Inventory Selection</label>
                  <div className="flex items-center gap-6">
                    <button 
                      onClick={handleSelectAll}
                      className="text-[11px] font-black uppercase tracking-widest text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors flex items-center gap-2"
                    >
                      <div className={cn(
                        "w-4 h-4 rounded border-2 flex items-center justify-center transition-all",
                        selectedProductIds.length > 0 && selectedProductIds.length === filteredProducts.length
                          ? "bg-zinc-900 dark:bg-white border-zinc-900 dark:border-white"
                          : "border-zinc-200 dark:border-zinc-800"
                      )}>
                        {selectedProductIds.length > 0 && <Check size={10} className="text-white dark:text-zinc-900" strokeWidth={4} />}
                      </div>
                      Select All
                    </button>
                    <div className="px-3 py-1 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-full text-[10px] font-black tracking-tighter">
                      {selectedProductIds.length} SELECTED
                    </div>
                  </div>
                </div>

                <div className="relative group">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={18} />
                  <input 
                    type="text"
                    placeholder="Filter items by name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-zinc-100 dark:bg-zinc-800/50 border-none rounded-2xl pl-12 pr-4 py-4 text-sm font-bold text-zinc-900 dark:text-white focus:ring-4 focus:ring-zinc-900/5 dark:focus:ring-white/5 transition-all outline-none"
                  />
                </div>

                <div className="h-[480px] overflow-y-auto border-2 border-zinc-100 dark:border-zinc-800 rounded-3xl bg-zinc-50/30 dark:bg-zinc-950/30 p-3 space-y-2 custom-scrollbar transition-all">
                  <AnimatePresence mode="popLayout">
                    {filteredProducts.length === 0 ? (
                      <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="h-full flex flex-col items-center justify-center text-zinc-400 space-y-4"
                      >
                        <div className="p-6 bg-zinc-100 dark:bg-zinc-900 rounded-full">
                          <Filter size={40} strokeWidth={1.5} className="opacity-20" />
                        </div>
                        <p className="text-sm font-bold uppercase tracking-widest opacity-40">No items matching criteria</p>
                      </motion.div>
                    ) : (
                      filteredProducts.map((p, idx) => (
                        <motion.button 
                          key={p.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.01 }}
                          onClick={() => toggleProduct(p.id)}
                          disabled={p.is_offline}
                          className={cn(
                            "w-full flex items-center justify-between px-6 py-4 rounded-2xl transition-all border-2 group",
                            p.is_offline
                              ? "bg-zinc-100 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-800 opacity-50 cursor-not-allowed"
                              : selectedProductIds.includes(p.id) 
                                ? "bg-zinc-900 dark:bg-white border-zinc-900 dark:border-white shadow-xl shadow-zinc-900/10" 
                                : "bg-white dark:bg-zinc-900 border-zinc-50 dark:border-zinc-800 hover:border-zinc-200 dark:hover:border-zinc-700"
                          )}
                        >
                          <div className="flex flex-col items-start gap-1">
                            <div className="flex items-center gap-2">
                              <span className={cn(
                                "text-sm font-bold transition-colors",
                                p.is_offline ? "text-zinc-400" : selectedProductIds.includes(p.id) ? "text-white dark:text-zinc-900" : "text-zinc-700 dark:text-zinc-300"
                              )}>
                                {highlightText(p.product_name, searchQuery)}
                              </span>
                              {getHiddenStatus(p.id) && (
                                <span className={cn(
                                  "px-1.5 py-0.5 rounded-md text-[8px] font-black uppercase tracking-wider",
                                  selectedProductIds.includes(p.id) 
                                    ? "bg-white/20 text-white dark:text-zinc-900" 
                                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                                )}>
                                  Hidden ({getHiddenStatus(p.id)})
                                </span>
                              )}
                            </div>
                            {p.ingredients && (
                              <div className="flex items-center gap-1.5">
                                <span className={cn(
                                  "text-[10px] font-black uppercase tracking-widest",
                                  selectedProductIds.includes(p.id) ? "text-white/60 dark:text-zinc-900/60" : "text-zinc-400 dark:text-zinc-500"
                                )}>
                                  Ingredients:
                                </span>
                                <span className={cn(
                                  "text-[10px] font-medium line-clamp-1 text-left",
                                  selectedProductIds.includes(p.id) ? "text-white/80 dark:text-zinc-900/80" : "text-zinc-500 dark:text-zinc-400"
                                )}>
                                  {highlightText(p.ingredients, searchQuery)}
                                </span>
                              </div>
                            )}
                            {p.is_offline && (
                              <span className="text-[10px] font-black text-red-500 uppercase tracking-widest mt-1">Offline - Cannot Select</span>
                            )}
                          </div>
                          <div className={cn(
                            "w-6 h-6 rounded-full flex items-center justify-center transition-all",
                            p.is_offline
                              ? "bg-zinc-200 dark:bg-zinc-800"
                              : selectedProductIds.includes(p.id) 
                                ? "bg-white/20 dark:bg-zinc-900/10" 
                                : "bg-zinc-100 dark:bg-zinc-800 group-hover:bg-zinc-200 dark:group-hover:bg-zinc-700"
                          )}>
                            {selectedProductIds.includes(p.id) && !p.is_offline && <Check size={14} className="text-white dark:text-zinc-900" strokeWidth={3} />}
                            {p.is_offline && <X size={14} className="text-zinc-400" strokeWidth={3} />}
                          </div>
                        </motion.button>
                      ))
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Form Column */}
        <motion.div 
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
          className={cn("xl:col-span-7", user?.role_name === 'Area Manager' && "hidden")}
        >
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] relative overflow-hidden">
            {user?.role_name === 'Restaurants' && (
              <button
                type="button"
                onClick={handleAutoFill}
                disabled={isAutoFilling}
                className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-amber-500/20 transition-all mb-8 disabled:opacity-50"
              >
                {isAutoFilling ? <div className="w-3 h-3 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" /> : <Sparkles size={14} />}
                {lang === 'en' ? 'Auto-fill Most Frequent' : 'تعبئة تلقائية (الأكثر تكراراً)'}
              </button>
            )}
            <div className="absolute top-0 right-0 p-10 opacity-[0.02] dark:opacity-[0.04] pointer-events-none">
              <AlertCircle size={180} strokeWidth={1} />
            </div>

            <form onSubmit={handleSubmit} className="space-y-6 relative z-10">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500 ml-1">Reporting Agent</label>
                  <div className="relative group">
                    <User className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={18} />
                    <input 
                      type="text"
                      placeholder="e.g., Sarah Johnson"
                      required
                      readOnly
                      value={formData.agent_name}
                      className="w-full bg-zinc-100 dark:bg-zinc-800 border-2 border-zinc-200 dark:border-zinc-700 rounded-xl pl-12 pr-4 py-3.5 text-sm font-bold text-zinc-500 dark:text-zinc-400 cursor-not-allowed outline-none shadow-sm"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500 ml-1">Primary Reason</label>
                  <div className="relative group">
                    <AlertCircle className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={18} />
                    <select 
                      required
                      value={formData.reason}
                      onChange={(e) => setFormData({...formData, reason: e.target.value})}
                      className="w-full bg-zinc-50 dark:bg-zinc-950 border-2 border-zinc-100 dark:border-zinc-800 rounded-xl pl-12 pr-4 py-3.5 text-sm font-bold text-zinc-900 dark:text-white focus:border-zinc-900 dark:focus:border-white transition-all outline-none appearance-none cursor-pointer shadow-sm"
                    >
                      <option value="">Select Reason...</option>
                      {fields.find(f => f.name_en === 'Primary Reason')?.options?.map((opt: any) => (
                        <option key={opt.id} value={opt.value_en}>
                          {lang === 'en' ? opt.value_en : opt.value_ar}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={18} />
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500 ml-1">Internal Documentation</label>
                <textarea 
                  placeholder="Provide additional technical or operational context..."
                  rows={4}
                  value={formData.comment}
                  onChange={(e) => setFormData({...formData, comment: e.target.value})}
                  className="w-full bg-zinc-50 dark:bg-zinc-950 border-2 border-zinc-100 dark:border-zinc-800 rounded-2xl px-6 py-4 text-sm font-bold text-zinc-900 dark:text-white focus:border-zinc-900 dark:focus:border-white transition-all outline-none resize-none shadow-sm"
                />
              </div>

              <div className="grid grid-cols-1 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500 ml-1">Responsible Authority</label>
                  <div className="relative group">
                    <Shield className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={18} />
                    <select 
                      required
                      value={formData.responsible_party}
                      onChange={(e) => setFormData({...formData, responsible_party: e.target.value})}
                      className="w-full bg-zinc-50 dark:bg-zinc-950 border-2 border-zinc-100 dark:border-zinc-800 rounded-xl pl-12 pr-4 py-3.5 text-sm font-bold text-zinc-900 dark:text-white focus:border-zinc-900 dark:focus:border-white transition-all outline-none appearance-none cursor-pointer shadow-sm"
                    >
                      <option value="">Select Authority...</option>
                      {responsibleParties.map(r => (
                        <option key={r.id} value={r.name}>{r.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" size={18} />
                  </div>
                </div>
              </div>

              <div className="pt-6 border-t border-zinc-100 dark:border-zinc-800 flex flex-col sm:flex-row items-center gap-6">
                <button 
                  type="submit"
                  disabled={submitting || success}
                  className={cn(
                    "w-full sm:w-auto px-10 py-4 rounded-xl font-black text-base tracking-tight transition-all active:scale-95 flex items-center justify-center gap-3 shadow-xl",
                    success 
                      ? "bg-emerald-500 text-white shadow-emerald-500/20" 
                      : "bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-100 shadow-zinc-900/20 dark:shadow-white/10"
                  )}
                >
                  {success ? (
                    <>
                      <Check size={20} strokeWidth={3} />
                      SUCCESSFUL
                    </>
                  ) : submitting ? (
                    <>
                      <div className="w-4 h-4 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                      PROCESSING...
                    </>
                  ) : (
                    <>
                      <Send size={18} />
                      {user?.role_name === 'Restaurants' ? (lang === 'en' ? 'SUBMIT REQUEST' : 'إرسال طلب') : 'EXECUTE HIDE'}
                    </>
                  )}
                </button>
                <div className="flex items-center gap-2 text-zinc-400">
                  <Sparkles size={14} className="text-amber-400" />
                  <p className="text-[10px] font-black uppercase tracking-widest leading-tight">
                    {selectedProductIds.length} items will be processed<br/>for {selectedBranch === 'all' ? 'all active branches' : 'selected branch'}
                  </p>
                </div>
              </div>
            </form>
          </div>
        </motion.div>
      </div>

      {/* Hidden Items List Section - Full Width Below */}
      <motion.div 
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-zinc-200 dark:border-zinc-800 p-8 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] relative overflow-hidden"
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">Currently Hidden Items</h3>
            <p className="text-zinc-500 dark:text-zinc-400 text-sm font-medium">Real-time view of products restricted from branches.</p>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={exportToExcel}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl font-bold text-sm hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20 active:scale-95"
            >
              <FileText size={16} />
              {lang === 'ar' ? 'تحميل إكسيل' : 'Download Excel'}
            </button>
            <div className="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg text-[9px] font-black tracking-widest text-zinc-500">
              {hiddenItems.length} TOTAL RECORDS
            </div>
          </div>
        </div>

        <div className="border-2 border-zinc-100 dark:border-zinc-800 rounded-2xl overflow-hidden bg-zinc-50/30 dark:bg-zinc-950/30">
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white dark:bg-zinc-900">
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">Product Name</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">Brand</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">Branch</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">Hide Date</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400">Hide Time</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <AnimatePresence mode="popLayout">
                  {hiddenItems.length === 0 ? (
                    <motion.tr
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                    >
                      <td colSpan={6} className="px-6 py-12 text-center">
                        <p className="text-xs font-bold uppercase tracking-widest text-zinc-300 dark:text-zinc-700">No hidden items currently</p>
                      </td>
                    </motion.tr>
                  ) : (
                    hiddenItems.map((item, idx) => (
                      <motion.tr 
                        key={item.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.01 }}
                        className="bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-all group"
                      >
                        <td className="px-6 py-4">
                          <span className="text-xs font-black text-zinc-900 dark:text-white">{item.product_name}</span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-[9px] font-black text-zinc-400 uppercase tracking-tight">{item.brand_name}</span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <MapPin size={10} className="text-zinc-400" />
                            <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400">{item.branch_name || 'All Branches'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase">
                            {formatDate(item.created_at, { year: 'numeric', month: 'numeric', day: 'numeric' })}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                            <Clock size={10} />
                            <span className="text-[9px] font-bold uppercase tracking-tighter">
                              {formatDate(item.created_at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleWhatsApp(item)}
                              className="p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                              title="Share via WhatsApp"
                            >
                              <MessageCircle size={14} />
                            </button>
                            {user?.role_name !== 'Area Manager' && (
                              <button 
                                onClick={() => handleUnhide(item.id)}
                                className="p-1.5 text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                title="Unhide Now"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
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
      </motion.div>

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
              {toast.type === 'success' ? <Check size={20} /> : <AlertCircle size={20} />}
            </div>
            <span className="text-lg tracking-tight">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
