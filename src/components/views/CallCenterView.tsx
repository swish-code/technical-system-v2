import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn } from '../../lib/utils';
import { Search, Filter, LayoutGrid, List, Clock, Send, CheckCircle2, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { Product, Brand, DynamicField, ProductFieldValue, Branch, LateOrderRequest } from '../../types';

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

const PLATFORMS = [
  'Talabat',
  'Keeta',
  'Jahez',
  'Deliveroo',
  'Direct Call',
  'Web Site',
  'V-thru'
];

import { useFetch } from '../../hooks/useFetch';

export default function CallCenterView() {
  const { lang, user } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [products, setProducts] = useState<Product[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [fields, setFields] = useState<DynamicField[]>([]);
  const [fieldValues, setFieldValues] = useState<ProductFieldValue[]>([]);
  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, bRes, fRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/products?limit=1000`),
        fetchWithAuth(`${API_URL}/brands`),
        fetchWithAuth(`${API_URL}/fields`),
      ]);
      
      if (!pRes.ok) {
        const errorData = await pRes.json().catch(() => ({}));
        throw new Error(`Failed to fetch products: ${pRes.status} ${errorData.error || ''}`);
      }
      if (!bRes.ok) {
        const errorData = await bRes.json().catch(() => ({}));
        throw new Error(`Failed to fetch brands: ${bRes.status} ${errorData.error || ''}`);
      }
      if (!fRes.ok) {
        const errorData = await fRes.json().catch(() => ({}));
        throw new Error(`Failed to fetch fields: ${fRes.status} ${errorData.error || ''}`);
      }

      const pData = await pRes.json();
      const bData = await bRes.json();
      const fData = await fRes.json();

      setProducts(pData.products || []);
      setFieldValues(pData.fieldValues || []);
      const brandsList = Array.isArray(bData) ? bData : [];
      setBrands(brandsList);
      if (brandsList.length === 1) {
        setBrandFilter(brandsList[0].id.toString());
      }
      setFields(fData.fields || []);
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch call center data", err);
      setError(err.message || 'An unexpected error occurred while fetching call center data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const productNameFieldId = (Array.isArray(fields) ? fields : []).find(f => f.name_en === (lang === 'en' ? 'Product Name (EN)' : 'Product Name (AR)'))?.id || (lang === 'en' ? 3 : 7);
  const categoryNameFieldId = (Array.isArray(fields) ? fields : []).find(f => f.name_en === (lang === 'en' ? 'Category Name (EN)' : 'Category Name (AR)'))?.id || (lang === 'en' ? 2 : 6);
  const descriptionFieldId = (Array.isArray(fields) ? fields : []).find(f => f.name_en === (lang === 'en' ? 'Description (EN)' : 'Description (AR)'))?.id || (lang === 'en' ? 4 : 8);
  const priceFieldId = (Array.isArray(fields) ? fields : []).find(f => f.name_en === 'Price')?.id || 5;

  const t = {
    en: {
      menu: "Menu Catalog",
      search: "Search menu items...",
      brand: "Brand",
      allBrands: "All Brands",
      price: "Price",
      category: "Category",
    },
    ar: {
      menu: "كتالوج المنيو",
      search: "البحث في القائمة...",
      brand: "العلامة التجارية",
      allBrands: "جميع العلامات التجارية",
      price: "السعر",
      category: "الفئة",
    }
  }[lang];

  const filteredProducts = products.filter(p => {
    const productName = fieldValues.find(fv => fv.product_id === p.id && fv.field_id === productNameFieldId)?.value || '';
    const matchesSearch = productName.toLowerCase().includes(search.toLowerCase());
    const matchesBrand = brandFilter === '' || p.brand_id.toString() === brandFilter;
    const matchesChannel = channelFilter === '' || (p.channels || []).includes(channelFilter);
    return matchesSearch && matchesBrand && matchesChannel;
  });

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
          onClick={() => fetchData()}
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
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
            Call <span className="text-brand">Center</span>
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium text-sm mt-0.5">Quick access to product information and pricing</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative group flex-1 md:flex-none">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors" size={16} />
            <input
              type="text"
              placeholder={t.search}
              className="w-full md:w-64 pl-10 pr-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-medium text-sm text-zinc-900 dark:text-white shadow-sm"
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
          <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl ml-auto">
            <button 
              onClick={() => setViewMode('grid')}
              className={cn("p-1.5 rounded-lg transition-colors", viewMode === 'grid' ? "bg-white dark:bg-zinc-700 text-brand shadow-sm" : "text-zinc-400 dark:text-zinc-500")}
            >
              <LayoutGrid size={18} />
            </button>
            <button 
              onClick={() => setViewMode('list')}
              className={cn("p-1.5 rounded-lg transition-colors", viewMode === 'list' ? "bg-white dark:bg-zinc-700 text-brand shadow-sm" : "text-zinc-400 dark:text-zinc-500")}
            >
              <List size={18} />
            </button>
          </div>
        </div>

        {viewMode === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {filteredProducts.map((product) => {
              const name = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === productNameFieldId)?.value;
              const desc = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === descriptionFieldId)?.value;
              const price = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === priceFieldId)?.value;
              const category = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === categoryNameFieldId)?.value;

              return (
                <div key={product.id} className={cn(
                  "bg-white dark:bg-zinc-900 rounded-2xl border overflow-hidden shadow-sm hover:shadow-md transition-all group relative",
                  product.is_offline ? "border-red-200 dark:border-red-900/30 bg-red-50/30 dark:bg-red-900/10 grayscale-[0.5] opacity-80" : "border-zinc-200 dark:border-zinc-800"
                )}>
                  <div className="h-40 bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center relative">
                    <span className="text-zinc-400 dark:text-zinc-500 font-bold text-lg">{product.brand_name}</span>
                    <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
                      <div className="bg-white/90 dark:bg-zinc-900/90 backdrop-blur px-2 py-1 rounded-lg text-xs font-bold text-zinc-900 dark:text-white shadow-sm">
                        {category}
                      </div>
                      {!!product.is_offline && (
                        <div className="bg-red-500 text-white px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest shadow-sm">
                          Offline
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="p-5">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className={cn("font-bold line-clamp-1", product.is_offline ? "text-zinc-500" : "text-zinc-900 dark:text-white")}>{name}</h3>
                      <span className={cn("font-bold whitespace-nowrap", product.is_offline ? "text-zinc-400" : "text-emerald-600 dark:text-emerald-400")}>{price} KD</span>
                    </div>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 line-clamp-2 mb-4 h-10">{desc}</p>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                      <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">{product.brand_name}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
                <tr>
                  <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Brand</th>
                  <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Name</th>
                  <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Category</th>
                  <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {filteredProducts.map((product) => {
                  const name = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === productNameFieldId)?.value;
                  const price = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === priceFieldId)?.value;
                  const category = fieldValues.find(fv => fv.product_id === product.id && fv.field_id === categoryNameFieldId)?.value;
                  return (
                    <tr key={product.id} className={cn(
                      "hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors",
                      product.is_offline && "bg-red-50/30 dark:bg-red-900/10 grayscale-[0.5] opacity-80"
                    )}>
                      <td className="px-6 py-4 text-zinc-500 dark:text-zinc-400">{product.brand_name}</td>
                      <td className={cn("px-6 py-4 font-medium", product.is_offline ? "text-zinc-400" : "text-zinc-900 dark:text-white")}>{name}</td>
                      <td className="px-6 py-4 text-zinc-500 dark:text-zinc-400">{category}</td>
                      <td className={cn("px-6 py-4 font-bold", product.is_offline ? "text-zinc-400" : "text-emerald-600 dark:text-emerald-400")}>{price} KD</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
