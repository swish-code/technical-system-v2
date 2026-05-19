import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, safeJson } from '../../lib/utils';
import { Search, Filter, Eye, X, Copy, CheckCircle2, Edit2, Trash2, Globe, Calendar, Power, PowerOff, RefreshCw, AlertCircle, Download, Upload, FileSpreadsheet } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Product, Brand, DynamicField, ProductFieldValue } from '../../types';
import { useWebSocket } from '../../hooks/useWebSocket';
import ProductModal from '../ProductModal';
import ConfirmModal from '../ConfirmModal';
import { utils, writeFile, read } from 'xlsx';

const CHANNELS = [
  'Talabat',
  'Keeta',
  'Jahez',
  'Deliveroo',
  'Call Center',
  'Web Site',
  'Walk In',
  'V-thru'
];

import { useFetch } from '../../hooks/useFetch';

export default function TechnicalView() {
  const { lang, user, logout } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [products, setProducts] = useState<Product[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [fields, setFields] = useState<DynamicField[]>([]);
  const [fieldValues, setFieldValues] = useState<ProductFieldValue[]>([]);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [daysFilter, setDaysFilter] = useState('all');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importBrandId, setImportBrandId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const itemsPerPage = 10;

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    productId: number | null;
  }>({
    isOpen: false,
    productId: null
  });

  const lastMessage = useWebSocket();

  const fetchData = async (pageNum = currentPage) => {
    setLoading(true);
    setError(null);
    try {
      const queryParams = new URLSearchParams({
        page: pageNum.toString(),
        limit: itemsPerPage.toString(),
        brand_id: brandFilter,
        search: search,
        days: daysFilter
      });

      const [pRes, bRes, fRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/products?${queryParams.toString()}`),
        fetchWithAuth(`${API_URL}/brands`),
        fetchWithAuth(`${API_URL}/fields`),
      ]);
      
      if (!pRes.ok) {
        const errorData = await safeJson(pRes);
        throw new Error(`Failed to fetch products: ${pRes.status} ${errorData?.error || ''}`);
      }
      if (!bRes.ok) {
        const errorData = await safeJson(bRes);
        throw new Error(`Failed to fetch brands: ${bRes.status} ${errorData?.error || ''}`);
      }
      if (!fRes.ok) {
        const errorData = await safeJson(fRes);
        throw new Error(`Failed to fetch fields: ${fRes.status} ${errorData?.error || ''}`);
      }

      const pData = await safeJson(pRes);
      const bData = await safeJson(bRes);
      const fData = await safeJson(fRes);

      setProducts(pData?.products || []);
      setFieldValues(pData?.fieldValues || []);
      const brandsList = Array.isArray(bData) ? bData : [];
      setBrands(brandsList);
      setFields(fData?.fields || []);
      setTotalPages(pData?.totalPages || 1);
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch technical data", err);
      setError(err.message || 'An unexpected error occurred while fetching technical data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(1);
    setCurrentPage(1);
  }, [search, brandFilter, channelFilter, daysFilter]);

  useEffect(() => {
    fetchData(currentPage);
  }, [currentPage]);

  useEffect(() => {
    if (lastMessage?.type === 'CODE_UPDATED' || lastMessage?.type === 'PRODUCT_CREATED') {
      fetchData(currentPage);
    }
  }, [lastMessage]);

  const canCopy = user?.role_name === 'Technical Team' || user?.role_name === 'Manager' || user?.role_name === 'Super Visor' || user?.role_name.startsWith('Marketing');

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    showToast(lang === 'en' ? 'Text Copied' : 'تم نسخ النص');
  };

  const executeDelete = async () => {
    if (confirmModal.productId === null) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/products/${confirmModal.productId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchData(currentPage);
        setConfirmModal({ isOpen: false, productId: null });
        showToast(lang === 'en' ? 'Product deleted' : 'تم حذف المنتج');
      }
    } catch (error) {
      console.error("Error deleting product:", error);
    }
  };

  const handleToggleOffline = async (productId: number) => {
    try {
      const res = await fetchWithAuth(`${API_URL}/products/${productId}/toggle-offline`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await safeJson(res);
        showToast(lang === 'en' ? `Product is now ${data?.is_offline ? 'Offline' : 'Active'}` : `المنتج الآن ${data?.is_offline ? 'غير متصل' : 'نشط'}`);
        fetchData(currentPage);
      }
    } catch (error) {
      console.error("Error toggling offline status:", error);
    }
  };

  const handleBulkOffline = async (isOffline: boolean) => {
    if (selectedIds.length === 0) return;
    setIsBulkProcessing(true);
    try {
      const results = await Promise.all(selectedIds.map(id => 
        fetchWithAuth(`${API_URL}/products/${id}/toggle-offline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force_status: isOffline })
        })
      ));
      
      const successCount = results.filter(r => r.ok).length;
      showToast(lang === 'en' 
        ? `Updated ${successCount} products to ${isOffline ? 'Offline' : 'Active'}` 
        : `تم تحديث ${successCount} منتج إلى ${isOffline ? 'غير متصل' : 'نشط'}`);
      
      setSelectedIds([]);
      fetchData(currentPage);
    } catch (error) {
      console.error("Error in bulk update:", error);
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const handleSelectAll = () => {
    if (selectedIds.length === products.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(products.map(p => p.id));
    }
  };

  const handleExportExcel = async () => {
    setIsExporting(true);
    try {
      const queryParams = new URLSearchParams({
        page: '1',
        limit: '1000000',
        brand_id: brandFilter,
        search: search,
        days: daysFilter
      });

      const res = await fetchWithAuth(`${API_URL}/products?${queryParams.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch products for export');
      
      const data = await safeJson(res);
      const allProducts = data?.products || [];
      const allFieldValues = data?.fieldValues || [];

      const excelData = allProducts.map((p: any) => {
        const row: any = {
          'ID': p.id,
          'Brand': p.brand_name,
          'PLU': p.product_code || '',
          'Status': p.is_offline ? 'Offline' : 'Active',
          'Created At': new Date(p.created_at).toLocaleDateString(),
          'Creator': p.creator_name || ''
        };

        fields.forEach(field => {
          const val = allFieldValues.find((fv: any) => fv.product_id === p.id && fv.field_id === field.id);
          row[field.name_en] = val?.value || '';
        });

        row['Channels'] = (p.channels || []).join(', ');

        if (p.modifierGroups && p.modifierGroups.length > 0) {
          row['Modifiers'] = p.modifierGroups.map((mg: any) => {
            const options = mg.options.map((opt: any) => `${opt.name_en} (+${opt.price_adjustment})`).join(', ');
            return `${mg.name_en}: [${options}]`;
          }).join(' | ');
        } else {
          row['Modifiers'] = '';
        }

        return row;
      });

      const worksheet = utils.json_to_sheet(excelData);
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, worksheet, "Products");
      writeFile(workbook, `Products_Export_${new Date().toISOString().split('T')[0]}.xlsx`);
      
      showToast(lang === 'en' ? 'Excel Exported Successfully' : 'تم تصدير ملف الإكسيل بنجاح');
    } catch (error) {
      console.error("Export error:", error);
      showToast(lang === 'en' ? 'Failed to export Excel' : 'فشل تصدير ملف الإكسيل');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !importBrandId) return;

    setIsImporting(true);
    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const dataBuffer = evt.target?.result;
          const wb = read(dataBuffer, { type: 'array' });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const data = utils.sheet_to_json(ws);

          if (data.length === 0) {
            showToast(lang === 'en' ? 'Excel file is empty' : 'ملف الإكسيل فارغ');
            setIsImporting(false);
            return;
          }

          const res = await fetchWithAuth(`${API_URL}/products/bulk-import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              brand_id: importBrandId,
              products: data
            })
          });

          if (res.ok) {
            const result = await safeJson(res);
            showToast(lang === 'en' ? `Successfully imported ${result.count} products` : `تم استيراد ${result.count} منتج بنجاح`);
            setIsImportModalOpen(false);
            setImportBrandId('');
            fetchData(1);
          } else {
            const errorData = await safeJson(res);
            showToast(lang === 'en' ? `Import failed: ${errorData?.error || 'Unknown error'}` : `فشل الاستيراد: ${errorData?.error || 'خطأ غير معروف'}`);
          }
        } catch (err) {
          console.error("Error processing Excel:", err);
          showToast(lang === 'en' ? 'Failed to process Excel file' : 'فشل في معالجة ملف الإكسيل');
        } finally {
          setIsImporting(false);
        }
      };
      reader.readAsArrayBuffer(file);
    } catch (error) {
      console.error("Import error:", error);
      showToast(lang === 'en' ? 'Failed to import Excel' : 'فشل استيراد ملف الإكسيل');
      setIsImporting(false);
    }
    // Reset input
    e.target.value = '';
  };

  const t = {
    en: {
      title: "Technical Overview",
      search: "Search products or codes...",
      brand: "Brand",
      allBrands: "All Brands",
      code: "Product Code",
      details: "View Details",
      noCode: "No Code Assigned",
      export: "Export Excel",
      exporting: "Exporting...",
      import: "Import Excel",
      importing: "Importing...",
      selectBrand: "Select Brand for Import",
      chooseFile: "Choose Excel File",
      bulkImport: "Bulk Product Import",
    },
    ar: {
      title: "نظرة عامة تقنية",
      search: "البحث عن المنتجات أو الأكواد...",
      brand: "العلامة التجارية",
      allBrands: "جميع العلامات التجارية",
      code: "كود المنتج",
      details: "عرض التفاصيل",
      noCode: "لم يتم تعيين كود",
      export: "تصدير إكسيل",
      exporting: "جاري التصدير...",
      import: "استيراد إكسيل",
      importing: "جاري الاستيراد...",
      selectBrand: "اختر العلامة التجارية للاستيراد",
      chooseFile: "اختر ملف الإكسيل",
      bulkImport: "استيراد منتجات بالجملة",
    }
  }[lang];

  const productNameFieldId = fields.find(f => f.name_en === 'Product Name (EN)')?.id || 3;
  const productArNameFieldId = fields.find(f => f.name_en === 'Product Name (AR)')?.id || 7;

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
          onClick={() => fetchData(1)}
          className="px-8 py-4 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-2xl font-black shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-3"
        >
          <RefreshCw size={20} />
          {lang === 'ar' ? 'إعادة المحاولة' : 'Retry Connection'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20">
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={lang === 'en' ? 'Delete Product' : 'حذف المنتج'}
        message={lang === 'en' ? 'Are you sure you want to delete this product?' : 'هل أنت متأكد أنك تريد حذف هذا المنتج؟'}
        onConfirm={executeDelete}
        onCancel={() => setConfirmModal({ isOpen: false, productId: null })}
        confirmText={lang === 'en' ? 'Delete' : 'حذف'}
        cancelText={lang === 'en' ? 'Cancel' : 'إلغاء'}
        lang={lang}
      />
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
            Technical <span className="text-brand">Overview</span>
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium text-sm mt-0.5">Detailed technical specifications and product mapping</p>
        </div>
          <div className="flex flex-wrap items-center gap-3">
            {user?.role_name && !user.role_name.toLowerCase().includes('restaurant') && (
              <button
                onClick={() => setIsImportModalOpen(true)}
                className="px-4 py-2.5 rounded-xl bg-brand text-white text-xs font-black uppercase tracking-widest hover:bg-brand/90 transition-all flex items-center gap-2"
              >
                <Upload size={16} />
                {t.import}
              </button>
            )}
            <button
              onClick={handleExportExcel}
              disabled={isExporting}
              className="px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-xs font-black uppercase tracking-widest hover:bg-emerald-600 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              {isExporting ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
              {isExporting ? t.exporting : t.export}
            </button>
            {products.length > 0 && (
              <button
                onClick={handleSelectAll}
                className="px-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 text-xs font-black uppercase tracking-widest hover:bg-brand hover:text-white transition-all flex items-center gap-2"
              >
                <div className={cn(
                  "w-4 h-4 rounded border-2 flex items-center justify-center transition-all",
                  selectedIds.length > 0 && selectedIds.length === products.length
                    ? "bg-white dark:bg-zinc-900 border-white dark:border-zinc-900"
                    : "border-zinc-300 dark:border-zinc-600"
                )}>
                  {selectedIds.length > 0 && <CheckCircle2 size={10} className={cn(selectedIds.length === products.length ? "text-brand" : "text-white")} />}
                </div>
                {selectedIds.length === products.length ? (lang === 'en' ? 'Deselect All' : 'إلغاء تحديد الكل') : (lang === 'en' ? 'Select All' : 'تحديد الكل')}
              </button>
            )}
            <div className="relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
            <input
              type="text"
              placeholder={t.search}
              className="w-full md:w-56 pl-10 pr-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-medium text-sm text-zinc-900 dark:text-white shadow-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="px-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-bold text-sm text-zinc-900 dark:text-white shadow-sm"
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
          >
            <option value="">{t.allBrands}</option>
            {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select
            className="px-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-bold text-sm text-zinc-900 dark:text-white shadow-sm"
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
          >
            <option value="">All Channels</option>
            {CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="relative group">
            <Calendar className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
            <select
              className="pl-10 pr-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-bold text-sm text-zinc-900 dark:text-white shadow-sm appearance-none"
              value={daysFilter}
              onChange={(e) => setDaysFilter(e.target.value)}
            >
              <option value="all">All Time</option>
              <option value="7">Last 7 Days</option>
              <option value="30">Last 30 Days</option>
              <option value="90">Last 90 Days</option>
            </select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          <div className="col-span-full flex flex-col items-center justify-center py-20 space-y-4">
            <RefreshCw className="w-10 h-10 text-brand animate-spin" />
            <p className="text-zinc-500 font-medium">{lang === 'ar' ? 'جاري التحميل...' : 'Loading products...'}</p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {products.map((product, index) => (
            <motion.div
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: index * 0.05 }}
              key={product.id}
              onClick={() => toggleSelect(product.id)}
              className={cn(
                "glass-card p-6 rounded-[2rem] border transition-all group relative overflow-hidden cursor-pointer",
                selectedIds.includes(product.id) ? "ring-2 ring-brand border-brand/50 shadow-lg shadow-brand/10" : "",
                product.is_offline 
                  ? "border-red-200 dark:border-red-900/30 bg-red-50/30 dark:bg-red-900/10 grayscale-[0.5] opacity-80" 
                  : "border-zinc-100 dark:border-zinc-800 hover:border-brand/30"
              )}
            >
              {/* Selection Checkbox */}
              <div className={cn(
                "absolute top-4 right-4 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all z-10",
                selectedIds.includes(product.id) 
                  ? "bg-brand border-brand scale-110" 
                  : "bg-white/50 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-700 opacity-0 group-hover:opacity-100"
              )}>
                {selectedIds.includes(product.id) && <CheckCircle2 size={14} className="text-white" />}
              </div>

              {!!product.is_offline && (
                <div className="absolute top-0 left-0 w-full h-1 bg-red-500" />
              )}
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-black text-brand uppercase tracking-[0.2em] bg-brand/5 px-2 py-0.5 rounded-lg border border-brand/10">
                      {product.brand_name}
                    </span>
                    {!!product.is_offline && (
                      <span className="text-[9px] font-black text-red-600 uppercase tracking-[0.2em] bg-red-50 px-2 py-0.5 rounded-lg border border-red-100">
                        Offline
                      </span>
                    )}
                  </div>
                  <h3 className={cn(
                    "text-xl font-display font-black mt-2 tracking-tight",
                    product.is_offline ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-900 dark:text-white"
                  )}>
                    {fieldValues.find(fv => fv.product_id === product.id && fv.field_id === (lang === 'ar' ? productArNameFieldId : productNameFieldId))?.value || 
                     fieldValues.find(fv => fv.product_id === product.id && fv.field_id === productNameFieldId)?.value || 
                     "Product"}
                  </h3>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <div className={cn(
                    "px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border",
                    product.is_offline
                      ? "bg-zinc-100 text-zinc-400 border-zinc-200"
                      : product.product_code 
                        ? "bg-emerald-50 text-emerald-600 border-emerald-100" 
                        : "bg-amber-50 text-amber-600 border-amber-100"
                  )}>
                    {product.product_code || t.noCode}
                  </div>
                  <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    {(user?.role_name === 'Manager' || user?.role_name === 'Super Visor') && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleOffline(product.id);
                        }} 
                        className={cn(
                          "p-1.5 rounded-lg transition-all active:scale-90",
                          product.is_offline 
                            ? "bg-emerald-500 text-white hover:bg-emerald-600" 
                            : "bg-red-500 text-white hover:bg-red-600"
                        )}
                        title={product.is_offline ? "Set Active" : "Set Offline"}
                      >
                        {product.is_offline ? <Power size={14} /> : <PowerOff size={14} />}
                      </button>
                    )}
                    {(user?.role_name === 'Manager' || user?.role_name === 'Super Visor' || user?.role_name === 'Technical Team' || user?.role_name === 'Technical Back Office' || user?.role_name === 'Restaurants' || (user?.role_name.startsWith('Marketing') && user?.role_name !== 'Restaurants')) && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingProduct(product);
                          setIsEditModalOpen(true);
                        }} 
                        className="p-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-brand hover:text-white rounded-lg text-zinc-500 transition-all active:scale-90"
                      >
                        <Edit2 size={14} />
                      </button>
                    )}
                    {(user?.role_name === 'Manager' || user?.role_name === 'Super Visor' || user?.role_name === 'Technical Back Office' || (user?.role_name.startsWith('Marketing') && user?.role_name !== 'Restaurants')) && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmModal({ isOpen: true, productId: product.id });
                        }} 
                        className="p-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-red-500 hover:text-white rounded-lg text-zinc-500 transition-all active:scale-90"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="space-y-3 mb-6">
                {(() => {
                  const ingredientsField = fields.find(f => f.name_en === 'Ingredients');
                  const ingredientsVal = ingredientsField ? fieldValues.find(fv => fv.product_id === product.id && fv.field_id === ingredientsField.id) : null;
                  
                  const otherFields = fields
                    .filter(f => f.name_en !== 'Ingredients')
                    .filter(f => {
                      const val = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === f.id);
                      return !!val?.value;
                    })
                    .slice(0, ingredientsVal?.value ? 5 : 6);

                  const displayFields = [];
                  if (ingredientsVal?.value && ingredientsField) {
                    displayFields.push({ field: ingredientsField, value: ingredientsVal.value });
                  }
                  otherFields.forEach(f => {
                    const val = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === f.id);
                    displayFields.push({ field: f, value: val?.value });
                  });

                  return displayFields.map(({ field, value }) => (
                    <div key={field.id} className="flex justify-between items-center text-xs border-b border-zinc-50 dark:border-zinc-800/50 pb-1.5">
                      <span className="text-zinc-500 dark:text-zinc-400 font-medium">{lang === 'en' ? field.name_en : field.name_ar}</span>
                      <span className="font-bold text-zinc-900 dark:text-white truncate max-w-[150px]">{value || "-"}</span>
                    </div>
                  ));
                })()}
              </div>

              <button 
                onClick={() => setSelectedProduct(product)}
                className="w-full py-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 text-zinc-900 dark:text-white text-sm font-black hover:bg-brand hover:text-white transition-all flex items-center justify-center gap-2 group/btn"
              >
                <Eye size={16} className="group-hover/btn:scale-110 transition-transform" />
                {t.details}
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 mt-12">
          <button
            disabled={currentPage === 1}
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            className="px-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-sm font-bold hover:border-brand disabled:opacity-50 transition-all"
          >
            {lang === 'en' ? 'Previous' : 'السابق'}
          </button>
          
          <div className="flex items-center gap-2">
            {[...Array(totalPages)].map((_, i) => {
              const page = i + 1;
              const isFirstOrLast = page === 1 || page === totalPages;
              const isNearCurrent = Math.abs(page - currentPage) <= 1;

              if (isFirstOrLast || isNearCurrent) {
                return (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={cn(
                      "w-10 h-10 rounded-xl text-sm font-black transition-all",
                      currentPage === page
                        ? "bg-brand text-white shadow-lg shadow-brand/20 scale-110"
                        : "bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-brand"
                    )}
                  >
                    {page}
                  </button>
                );
              }

              if (page === currentPage - 2 || page === currentPage + 2) {
                return <span key={page} className="text-zinc-400">...</span>;
              }

              return null;
            })}
          </div>

          <button
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            className="px-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-sm font-bold hover:border-brand disabled:opacity-50 transition-all"
          >
            {lang === 'en' ? 'Next' : 'التالي'}
          </button>
        </div>
      )}

      {/* Bulk Action Bar */}
      <AnimatePresence>
        {selectedIds.length > 0 && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[150] bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-8 py-4 rounded-[2rem] shadow-2xl flex items-center gap-8 border border-white/10 dark:border-zinc-200 backdrop-blur-xl"
          >
            <div className="flex items-center gap-4 border-r border-white/10 dark:border-zinc-200 pr-8">
              <div className="w-10 h-10 rounded-full bg-brand flex items-center justify-center text-white font-black">
                {selectedIds.length}
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-black uppercase tracking-widest">{lang === 'en' ? 'Items Selected' : 'منتجات مختارة'}</span>
                <button onClick={() => setSelectedIds([])} className="text-[10px] font-bold text-zinc-400 hover:text-brand transition-colors text-left uppercase tracking-tighter">
                  {lang === 'en' ? 'Clear Selection' : 'إلغاء التحديد'}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {(user?.role_name === 'Manager' || user?.role_name === 'Super Visor') && (
                <>
                  <button
                    disabled={isBulkProcessing}
                    onClick={() => handleBulkOffline(true)}
                    className="px-6 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    {isBulkProcessing ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <PowerOff size={14} />}
                    {lang === 'en' ? 'Set Offline' : 'إيقاف التشغيل'}
                  </button>
                  <button
                    disabled={isBulkProcessing}
                    onClick={() => handleBulkOffline(false)}
                    className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    {isBulkProcessing ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Power size={14} />}
                    {lang === 'en' ? 'Set Active' : 'تنشيط الكل'}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Details Modal */}
      <AnimatePresence>
        {selectedProduct && (
          <div className="fixed inset-0 flex items-center justify-center z-[100] p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedProduct(null)}
              className="absolute inset-0 bg-zinc-900/80 backdrop-blur-xl"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white dark:bg-zinc-900 rounded-[3rem] w-full max-w-4xl max-h-[90vh] overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-2xl"
            >
              <div className="p-10 overflow-y-auto max-h-[90vh] custom-scrollbar">
                <div className="flex justify-between items-start mb-12">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xs font-black text-brand uppercase tracking-[0.3em]">{selectedProduct.brand_name}</span>
                      <div className="w-1 h-1 rounded-full bg-zinc-300" />
                      <span className="text-xs font-black text-zinc-400 uppercase tracking-[0.3em]">Technical Specs</span>
                    </div>
                    <h3 className="text-5xl font-display font-black text-zinc-900 dark:text-white tracking-tighter">
                      {fieldValues.find(fv => fv.product_id === selectedProduct.id && fv.field_id === productNameFieldId)?.value || "Product Details"}
                    </h3>
                  </div>
                  <button 
                    onClick={() => setSelectedProduct(null)} 
                    className="w-14 h-14 flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 hover:bg-red-500 hover:text-white rounded-2xl transition-all"
                  >
                    <X size={28} />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 gap-6">
                      {fields.map(field => {
                        const val = fieldValues.find(fv => fv.product_id === selectedProduct.id && fv.field_id === field.id);
                        return (
                          <div key={field.id} className="group relative bg-zinc-50/50 dark:bg-zinc-800/50 p-6 rounded-3xl border border-zinc-100 dark:border-zinc-800 transition-all hover:border-brand/20">
                            <div className="flex justify-between items-center mb-1">
                              <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">{lang === 'en' ? field.name_en : field.name_ar}</p>
                              {canCopy && val?.value && (
                                <button 
                                  onClick={() => handleCopy(val.value)}
                                  className="p-2 bg-white dark:bg-zinc-900 rounded-xl text-zinc-400 hover:text-brand transition-all opacity-0 group-hover:opacity-100 shadow-sm border border-zinc-100 dark:border-zinc-800"
                                >
                                  <Copy size={14} />
                                </button>
                              )}
                            </div>
                            <p className="text-lg font-bold text-zinc-900 dark:text-white">{val?.value || "-"}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-10">
                    {/* Codes Section */}
                    <div className="bg-zinc-900 text-white p-10 rounded-[2.5rem] shadow-2xl shadow-brand/20 relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-64 h-64 bg-brand/20 blur-[100px] -mr-32 -mt-32 group-hover:bg-brand/30 transition-all duration-700" />
                      <div className="relative z-10 space-y-8">
                        <div>
                          <p className="text-[10px] font-black text-brand uppercase tracking-[0.3em] mb-3">System Identifiers</p>
                          <div className="space-y-6">
                            <div className="flex justify-between items-center">
                              <span className="text-zinc-400 font-bold">Product Code</span>
                              <span className="text-2xl font-mono font-black text-brand">{selectedProduct.product_code || "---"}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Channels Display */}
                    {selectedProduct.channels && selectedProduct.channels.length > 0 && (
                      <div className="space-y-4">
                        <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Available Channels</p>
                        <div className="flex flex-wrap gap-3">
                          {selectedProduct.channels.map(channel => (
                            <span key={channel} className="px-5 py-2 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white text-xs font-black rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
                              {channel}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Modifier Groups Display */}
                    {(selectedProduct as any).modifierGroups?.length > 0 && (
                      <div className="space-y-6">
                        <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">Modifier Architecture</p>
                        <div className="space-y-4">
                          {(selectedProduct as any).modifierGroups.map((group: any) => (
                            <div key={group.id} className="bg-zinc-50/50 dark:bg-zinc-800/50 p-6 rounded-[2rem] border border-zinc-100 dark:border-zinc-800 group/mod">
                              <div className="flex justify-between items-start mb-4">
                                <div>
                                  <div className="flex items-center gap-3">
                                    <p className="text-lg font-display font-black text-zinc-900 dark:text-white">{lang === 'en' ? group.name_en : group.name_ar}</p>
                                    {canCopy && (
                                      <button 
                                        onClick={() => handleCopy(lang === 'en' ? group.name_en : group.name_ar)}
                                        className="text-zinc-400 hover:text-brand transition-all opacity-0 group-hover/mod:opacity-100"
                                      >
                                        <Copy size={14} />
                                      </button>
                                    )}
                                  </div>
                                  {group.code && <p className="text-[10px] font-mono font-bold text-brand mt-1">CODE: {group.code}</p>}
                                </div>
                                <span className="text-[10px] bg-white dark:bg-zinc-900 px-3 py-1 rounded-xl border border-zinc-200 dark:border-zinc-800 text-zinc-500 font-black uppercase tracking-widest">
                                  {group.selection_type}
                                </span>
                              </div>
                              <div className="space-y-2">
                                {group.options.map((opt: any) => (
                                  <div key={opt.id} className="flex justify-between items-center text-sm group/opt bg-white/50 dark:bg-zinc-900/50 p-3 rounded-xl border border-zinc-100/50 dark:border-zinc-800/50">
                                    <div className="flex flex-col">
                                      <div className="flex items-center gap-3">
                                        <span className="text-zinc-600 dark:text-zinc-400 font-bold">{lang === 'en' ? opt.name_en : opt.name_ar}</span>
                                        {canCopy && (
                                          <button 
                                            onClick={() => handleCopy(lang === 'en' ? opt.name_en : opt.name_ar)}
                                            className="text-zinc-400 hover:text-brand transition-all opacity-0 group-hover/opt:opacity-100"
                                          >
                                            <Copy size={12} />
                                          </button>
                                        )}
                                      </div>
                                      {opt.code && <span className="text-[10px] font-mono text-brand/70 font-bold">CODE: {opt.code}</span>}
                                    </div>
                                    <span className="font-black text-emerald-600 dark:text-emerald-400">+{opt.price_adjustment} KD</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Import Modal */}
      <AnimatePresence>
        {isImportModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsImportModalOpen(false)}
              className="absolute inset-0 bg-zinc-900/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-900 rounded-[2.5rem] p-8 shadow-2xl border border-zinc-100 dark:border-zinc-800"
            >
              <div className="flex justify-between items-center mb-8">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-brand/10 flex items-center justify-center text-brand">
                    <FileSpreadsheet size={24} />
                  </div>
                  <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">{t.bulkImport}</h3>
                </div>
                <button onClick={() => setIsImportModalOpen(false)} className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-all">
                  <X size={24} />
                </button>
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-black text-zinc-400 uppercase tracking-widest ml-1">{t.selectBrand}</label>
                  <select
                    className="w-full px-4 py-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800 border-2 border-zinc-100 dark:border-zinc-700 focus:border-brand outline-none transition-all font-bold text-zinc-900 dark:text-white"
                    value={importBrandId}
                    onChange={(e) => setImportBrandId(e.target.value)}
                  >
                    <option value="">{t.allBrands}</option>
                    {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>

                <div className="relative">
                  <input
                    type="file"
                    accept=".xlsx, .xls"
                    onChange={handleImportExcel}
                    disabled={!importBrandId || isImporting}
                    className="hidden"
                    id="excel-upload"
                  />
                  <label
                    htmlFor="excel-upload"
                    className={cn(
                      "flex flex-col items-center justify-center w-full h-40 border-2 border-dashed rounded-[2rem] transition-all cursor-pointer",
                      !importBrandId || isImporting
                        ? "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-800 cursor-not-allowed opacity-50"
                        : "bg-brand/5 border-brand/20 hover:border-brand/40 hover:bg-brand/10"
                    )}
                  >
                    {isImporting ? (
                      <RefreshCw className="w-10 h-10 text-brand animate-spin" />
                    ) : (
                      <>
                        <Upload className="w-10 h-10 text-brand mb-2" />
                        <span className="text-sm font-black text-zinc-900 dark:text-white">{t.chooseFile}</span>
                      </>
                    )}
                  </label>
                </div>

                <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-2xl border border-amber-100 dark:border-amber-900/30">
                  <div className="flex gap-3">
                    <AlertCircle className="text-amber-500 shrink-0" size={20} />
                    <p className="text-xs font-bold text-amber-700 dark:text-amber-400 leading-relaxed">
                      {lang === 'en' 
                        ? "Ensure your Excel columns match: Product Name En, PLU, price, description En, Product_Arabic, description_Arabic, Category Arabic, Category En."
                        : "تأكد من مطابقة أعمدة الإكسيل: Product Name En, PLU, price, description En, Product_Arabic, description_Arabic, Category Arabic, Category En."}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ProductModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        editingProduct={editingProduct}
        brands={brands}
        fields={fields}
        onSuccess={fetchData}
      />

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] bg-zinc-900 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 font-bold"
          >
            <CheckCircle2 size={18} className="text-emerald-400" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
