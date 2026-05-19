import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, safeJson } from '../../lib/utils';
import { Search, Save, CheckCircle2, ChevronDown, ChevronUp, Layers, Package, ListTree, Tag, RefreshCw, Filter, Calendar } from 'lucide-react';
import { Product, ModifierGroup, ModifierOption } from '../../types';
import { useWebSocket } from '../../hooks/useWebSocket';
import { motion, AnimatePresence } from 'motion/react';
import CodingModal from '../CodingModal';

import { useFetch } from '../../hooks/useFetch';

export default function CodingView() {
  const { lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [products, setProducts] = useState<Product[]>([]);
  const [fieldValues, setFieldValues] = useState<any[]>([]);
  const [brands, setBrands] = useState<any[]>([]);
  const [fields, setFields] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [codeSearch, setCodeSearch] = useState('');
  const [daysFilter, setDaysFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [showSuccess, setShowSuccess] = useState<number | null>(null);

  const lastMessage = useWebSocket();

  const fieldValueMap = useMemo(() => {
    const map = new Map<string, string>();
    fieldValues.forEach(fv => {
      map.set(`${fv.product_id}-${fv.field_id}`, fv.value);
    });
    return map;
  }, [fieldValues]);

  const fetchData = async (pageNum = page) => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams({
        page: pageNum.toString(),
        limit: '12',
        brand_id: brands.find(b => b.name === brandFilter)?.id?.toString() || '',
        search: search,
        code: codeSearch,
        days: daysFilter
      });

      const [productsRes, brandsRes, fieldsRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/products?${queryParams}`),
        fetchWithAuth(`${API_URL}/brands`),
        fetchWithAuth(`${API_URL}/fields`)
      ]);

      if (productsRes.ok && brandsRes.ok && fieldsRes.ok) {
        const productsData = await safeJson(productsRes);
        const brandsData = await safeJson(brandsRes);
        const fieldsData = await safeJson(fieldsRes);

        if (productsData) {
          setProducts(productsData.products || []);
          setTotalPages(productsData.totalPages || 1);
          setTotalItems(productsData.total || 0);
          setFieldValues(productsData.fieldValues || []);
        }
        
        if (brandsData) {
          setBrands(Array.isArray(brandsData) ? brandsData : []);
        }
        
        if (fieldsData) {
          setFields(fieldsData.fields || []);
        }
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch coding data", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(1);
    setPage(1);
  }, [brandFilter, search, codeSearch, daysFilter]);

  useEffect(() => {
    fetchData(page);
  }, [page]);

  useEffect(() => {
    if (lastMessage?.type === 'PRODUCT_CREATED' || lastMessage?.type === 'CODE_UPDATED') {
      fetchData(page);
    }
  }, [lastMessage]);

  const t = {
    en: {
      title: "PLU",
      search: "Search products or categories...",
      category: "Category",
      product: "Product",
      modifierGroup: "Modifier Group",
      option: "Option",
      save: "Save All PLUs",
      saving: "Saving...",
      productCode: "PLU",
      enterCode: "Enter PLU",
      modifierCode: "Modifier PLU",
      optionCode: "Option PLU",
      allBrands: "All Brands",
      allTime: "All Time",
      today: "Today",
      last7Days: "Last 7 Days",
      last30Days: "Last 30 Days",
      filterByBrand: "Filter by Brand",
      filterByDays: "Filter by Days",
      searchByCode: "Search by PLU...",
    },
    ar: {
      title: "PLU",
      search: "بحث عن المنتجات أو الأقسام...",
      category: "القسم",
      product: "المنتج",
      modifierGroup: "مجموعة المودفاير",
      option: "الخيار",
      save: "حفظ جميع الـ PLUs",
      saving: "جاري الحفظ...",
      productCode: "PLU",
      enterCode: "أدخل الـ PLU",
      modifierCode: "PLU المودفاير",
      optionCode: "PLU الخيار",
      allBrands: "جميع البراندات",
      allTime: "كل الأوقات",
      today: "اليوم",
      last7Days: "آخر 7 أيام",
      last30Days: "آخر 30 يوم",
      filterByBrand: "فلتر بالبراند",
      filterByDays: "فلتر بالأيام",
      searchByCode: "بحث بالـ PLU...",
    }
  }[lang];

  const productNameFieldId = fields.find(f => f.name_en === 'Product Name (EN)')?.id || 3;
  const categoryNameFieldId = fields.find(f => f.name_en === 'Category Name (EN)')?.id || 2;

  const handleUpdateProductCode = (productId: number, code: string) => {
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, product_code: code } : p));
  };

  const handleUpdateGroupCode = (productId: number, groupId: number, code: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      return {
        ...p,
        modifierGroups: p.modifierGroups?.map(mg => mg.id === groupId ? { ...mg, code } : mg)
      };
    }));
  };

  const handleUpdateOptionCode = (productId: number, groupId: number, optionId: number, code: string) => {
    setProducts(prev => prev.map(p => {
      if (p.id !== productId) return p;
      return {
        ...p,
        modifierGroups: p.modifierGroups?.map(mg => {
          if (mg.id !== groupId) return mg;
          return {
            ...mg,
            options: mg.options.map(opt => opt.id === optionId ? { ...opt, code } : opt)
          };
        })
      };
    }));
  };

  const handleSaveAllCodes = async (product: Product) => {
    setSaving(product.id);
    try {
      const response = await fetchWithAuth(`${API_URL}/products/${product.id}/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_code: product.product_code,
          modifier_groups: product.modifierGroups?.map(mg => ({
            id: mg.id,
            code: mg.code,
            options: mg.options.map(opt => ({
              id: opt.id,
              code: opt.code
            }))
          }))
        })
      });

      if (response.ok) {
        setShowSuccess(product.id);
        setTimeout(() => setShowSuccess(null), 3000);
      }
    } catch (err) {
      console.error("Failed to save codes", err);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
              <span className="text-brand">PLU</span>
            </h2>
            <p className="text-zinc-500 dark:text-zinc-400 font-medium text-sm mt-0.5">Assign and manage system PLUs for accurate tracking</p>
          </div>
          <div className="relative w-full max-w-md group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={18} />
            <input
              type="text"
              placeholder={t.search}
              className="w-full pl-10 pr-4 py-3 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-medium text-sm text-zinc-900 dark:text-white shadow-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 bg-zinc-50/50 dark:bg-zinc-800/50 p-4 rounded-3xl border border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 shadow-sm">
            <Filter size={16} className="text-brand" />
            <select
              className="bg-transparent outline-none text-xs font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-400"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
            >
              <option value="">{t.allBrands}</option>
              {brands.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
          </div>

          <div className="relative group">
            <Tag className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
            <input
              type="text"
              placeholder={t.searchByCode}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-bold text-sm text-zinc-900 dark:text-white shadow-sm"
              value={codeSearch}
              onChange={(e) => setCodeSearch(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 shadow-sm">
            <Calendar size={16} className="text-brand" />
            <select
              className="bg-transparent outline-none text-xs font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-400"
              value={daysFilter}
              onChange={(e) => setDaysFilter(e.target.value)}
            >
              <option value="all">{t.allTime}</option>
              <option value="today">{t.today}</option>
              <option value="7">{t.last7Days}</option>
              <option value="30">{t.last30Days}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <RefreshCw className="w-10 h-10 text-brand animate-spin" />
            <p className="text-zinc-500 font-medium">{lang === 'ar' ? 'جاري التحميل...' : 'Loading products...'}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <AnimatePresence mode="popLayout">
              {products.map((product, index) => {
                const categoryName = fieldValueMap.get(`${product.id}-${categoryNameFieldId}`) || 'No Category';
                const productName = fieldValueMap.get(`${product.id}-${productNameFieldId}`) || 'No Name';
                const isExpanded = expandedProduct === product.id;

                return (
                  <motion.div 
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    key={product.id} 
                    className={cn(
                      "glass-card rounded-[1.5rem] overflow-hidden transition-all duration-500",
                      product.is_offline && !isExpanded && "grayscale-[0.5] opacity-80",
                      isExpanded ? "ring-2 ring-brand/20 border-brand/30" : "hover:border-zinc-300 dark:hover:border-zinc-700"
                    )}
                  >
                    <div 
                      className={cn(
                        "p-6 flex items-center justify-between cursor-pointer transition-colors",
                        isExpanded ? "bg-brand/5 dark:bg-brand/10" : "hover:bg-zinc-50/50 dark:hover:bg-zinc-800/50"
                      )}
                      onClick={() => setExpandedProduct(isExpanded ? null : product.id)}
                    >
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-500",
                          isExpanded ? "bg-brand text-white shadow-lg shadow-brand/20" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500"
                        )}>
                          <Package size={24} />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[9px] font-black text-brand uppercase tracking-[0.2em] bg-brand/5 px-2 py-0.5 rounded-lg border border-brand/10">
                              {product.brand_name}
                            </span>
                            {!!product.is_offline && (
                              <span className="text-[9px] font-black text-red-600 uppercase tracking-[0.2em] bg-red-50 px-2 py-0.5 rounded-lg border border-red-100">
                                Offline
                              </span>
                            )}
                          </div>
                          <h3 className="text-xl font-display font-black text-zinc-900 dark:text-white tracking-tight">{productName}</h3>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right hidden md:block">
                          <p className="text-[9px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-0.5">Category</p>
                          <p className="text-xs font-bold text-zinc-900 dark:text-white">{categoryName}</p>
                        </div>
                        <div className={cn(
                          "w-8 h-8 rounded-full flex items-center justify-center transition-all duration-500",
                          isExpanded ? "bg-brand/10 text-brand rotate-180" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-400"
                        )}>
                          <ChevronDown size={16} />
                        </div>
                      </div>
                    </div>

                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div 
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="border-t border-zinc-100 dark:border-zinc-800"
                        >
                          <div className="p-8 space-y-8">
                            {/* 1. Product Level */}
                            <div className="space-y-4">
                              <div className="flex items-center gap-2">
                                <div className="w-6 h-6 rounded-lg bg-brand/10 text-brand flex items-center justify-center text-[10px] font-black">1</div>
                                <span className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">Product Configuration</span>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center bg-zinc-50/50 dark:bg-zinc-800/50 p-6 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                                <div className="space-y-0.5">
                                  <p className="text-[9px] font-black text-zinc-400 uppercase tracking-widest">Product Name</p>
                                  <p className="text-lg font-display font-bold text-zinc-900 dark:text-white">{productName}</p>
                                </div>
                                <div className="relative group">
                                  <Tag className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-300 group-focus-within:text-brand transition-colors" size={16} />
                                  <input
                                    type="text"
                                    placeholder={t.productCode}
                                    className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white focus:border-brand outline-none text-lg font-mono font-bold shadow-sm transition-all"
                                    value={product.product_code || ''}
                                    onChange={(e) => handleUpdateProductCode(product.id, e.target.value)}
                                  />
                                </div>
                              </div>
                            </div>

                            {/* 2. Modifier Groups Level */}
                            {product.modifierGroups && product.modifierGroups.length > 0 && (
                              <div className="space-y-6">
                                <div className="flex items-center gap-2">
                                  <div className="w-6 h-6 rounded-lg bg-brand/10 text-brand flex items-center justify-center text-[10px] font-black">2</div>
                                  <span className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">Modifiers & Options</span>
                                </div>
                                
                                <div className="space-y-8 ml-3 border-l-2 border-zinc-100 dark:border-zinc-800 pl-8">
                                  {product.modifierGroups.map((group) => (
                                    <div key={group.id} className="space-y-4 relative">
                                      <div className="absolute -left-[41px] top-4 w-3 h-3 rounded-full bg-brand border-2 border-white dark:border-zinc-900" />
                                      
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                                        <div className="font-display font-black text-zinc-900 dark:text-white text-base">
                                          {lang === 'en' ? group.name_en : group.name_ar}
                                        </div>
                                        <div className="relative group">
                                          <Tag className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-300 group-focus-within:text-brand transition-colors" size={14} />
                                          <input
                                            type="text"
                                            placeholder={t.modifierCode}
                                            className="w-full pl-10 pr-4 py-2.5 rounded-xl border-2 border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white focus:border-brand outline-none text-sm font-mono font-bold shadow-sm transition-all"
                                            value={group.code || ''}
                                            onChange={(e) => handleUpdateGroupCode(product.id, group.id, e.target.value)}
                                          />
                                        </div>
                                      </div>

                                      {/* Option Level */}
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 ml-4">
                                        {group.options.map((option) => (
                                          <div key={option.id} className="flex items-center justify-between gap-3 bg-white dark:bg-zinc-900 p-3 rounded-xl border border-zinc-100 dark:border-zinc-800 shadow-sm hover:border-brand/30 transition-all group/opt">
                                            <div className="flex flex-col">
                                              <span className="text-xs font-bold text-zinc-900 dark:text-white">
                                                {lang === 'en' ? option.name_en : option.name_ar}
                                              </span>
                                              <span className="text-[9px] text-brand font-black uppercase tracking-widest">+{option.price_adjustment} KD</span>
                                            </div>
                                            <div className="relative w-28">
                                              <input
                                                type="text"
                                                placeholder={t.optionCode}
                                                className="w-full px-3 py-1.5 rounded-lg border-2 border-zinc-50 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-white focus:border-brand outline-none text-[10px] font-mono font-bold transition-all"
                                                value={option.code || ''}
                                                onChange={(e) => handleUpdateOptionCode(product.id, group.id, option.id, e.target.value)}
                                              />
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="pt-8 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800">
                              <div className="flex items-center gap-2">
                                {showSuccess === product.id && (
                                  <motion.div
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    className="flex items-center gap-2 text-emerald-500 font-bold text-sm"
                                  >
                                    <CheckCircle2 size={16} />
                                    <span>{lang === 'ar' ? 'تم الحفظ بنجاح' : 'Saved successfully'}</span>
                                  </motion.div>
                                )}
                              </div>
                              <button
                                onClick={() => handleSaveAllCodes(product)}
                                disabled={saving === product.id}
                                className="btn-primary flex items-center gap-2 px-8 py-3 text-sm"
                              >
                                {saving === product.id ? (
                                  <>
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    {t.saving}
                                  </>
                                ) : (
                                  <>
                                    <Save size={18} />
                                    {t.save}
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-center gap-2 mt-12 pb-12">
            <button
              disabled={page === 1}
              onClick={() => setPage(prev => Math.max(1, prev - 1))}
              className="px-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-sm font-bold hover:border-brand disabled:opacity-50 transition-all"
            >
              {lang === 'en' ? 'Previous' : 'السابق'}
            </button>
            
            <div className="flex items-center gap-2">
              {[...Array(totalPages)].map((_, i) => {
                const p = i + 1;
                const isFirstOrLast = p === 1 || p === totalPages;
                const isNearCurrent = Math.abs(p - page) <= 1;

                if (isFirstOrLast || isNearCurrent) {
                  return (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={cn(
                        "w-10 h-10 rounded-xl text-sm font-black transition-all",
                        page === p
                          ? "bg-brand text-white shadow-lg shadow-brand/20 scale-110"
                          : "bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-brand"
                      )}
                    >
                      {p}
                    </button>
                  );
                }

                if (p === page - 2 || p === page + 2) {
                  return <span key={p} className="text-zinc-400">...</span>;
                }

                return null;
              })}
            </div>

            <button
              disabled={page === totalPages}
              onClick={() => setPage(prev => Math.min(totalPages, prev + 1))}
              className="px-4 py-2 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 text-sm font-bold hover:border-brand disabled:opacity-50 transition-all"
            >
              {lang === 'en' ? 'Next' : 'التالي'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
