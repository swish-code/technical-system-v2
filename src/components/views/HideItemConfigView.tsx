import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Search, Globe, MapPin, Package, UserCheck, AlertCircle, ChevronRight, X, AlertTriangle } from 'lucide-react';
import { API_URL } from '../../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';
import ConfirmModal from '../ConfirmModal';

interface Brand { id: number; name: string; }
interface Branch { id: number; brand_id: number; name: string; }
interface Product { id: number; brand_id: number; product_name: string; }
interface Responsible { id: number; name: string; }

import { useFetch } from '../../hooks/useFetch';
import { useAuth } from '../../context/AuthContext';

export default function HideItemConfigView() {
  const { fetchWithAuth } = useFetch();
  const { lang } = useAuth();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [responsible, setResponsible] = useState<Responsible[]>([]);
  const [fields, setFields] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeConfig, setActiveConfig] = useState<'brands' | 'branches' | 'products' | 'responsible' | 'reasons'>('brands');
  const [search, setSearch] = useState('');

  // Form states
  const [newBrand, setNewBrand] = useState('');
  const [newBranch, setNewBranch] = useState({ brandId: '', name: '' });
  const [newProduct, setNewProduct] = useState({ brandId: '', name: '' });
  const [newResp, setNewResp] = useState('');
  const [newReason, setNewReason] = useState({ en: '', ar: '' });

  // Custom Modal States
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    type: string;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    type: ''
  });

  const [errorAlert, setErrorAlert] = useState<{
    isOpen: boolean;
    message: string;
  }>({
    isOpen: false,
    message: ''
  });

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const [brandsRes, branchesRes, productsRes, respRes, fieldsRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/brands`),
        fetchWithAuth(`${API_URL}/branches`),
        fetchWithAuth(`${API_URL}/products`),
        fetchWithAuth(`${API_URL}/busy-responsible`),
        fetchWithAuth(`${API_URL}/fields`)
      ]);

      if (brandsRes.ok) {
        const data = await brandsRes.json();
        const brandsList = Array.isArray(data) ? data : [];
        setBrands(brandsList);
        if (brandsList.length === 1) {
          setNewBranch(prev => ({ ...prev, brandId: brandsList[0].id.toString() }));
          setNewProduct(prev => ({ ...prev, brandId: brandsList[0].id.toString() }));
        }
      }
      if (branchesRes.ok) {
        const data = await branchesRes.json();
        setBranches(Array.isArray(data) ? data : []);
      }
      if (fieldsRes.ok) {
        const data = await fieldsRes.json();
        setFields(data.fields || []);
      }
      if (productsRes.ok) {
        const data = await productsRes.json();
        if (data && Array.isArray(data.products)) {
          const productNameFieldId = (Array.isArray(fields) ? fields : []).find((f: any) => f.name_en === 'Product Name (EN)')?.id || 3;
          const mapped = data.products.map((p: any) => {
            const nameValue = data.fieldValues?.find((fv: any) => fv.product_id === p.id && fv.field_id === productNameFieldId);
            return { ...p, product_name: nameValue ? nameValue.value : 'Unnamed' };
          });
          setProducts(mapped);
        } else {
          setProducts([]);
        }
      }
      if (respRes.ok) {
        const data = await respRes.json();
        setResponsible(Array.isArray(data) ? data : []);
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch config data", err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddBrand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBrand) return;
    try {
      const res = await fetchWithAuth(`${API_URL}/brands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newBrand })
      });
      if (res.ok) {
        setNewBrand('');
        fetchAllData();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error(err);
    }
  };

  const handleAddBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranch.brandId || !newBranch.name) return;
    try {
      const res = await fetchWithAuth(`${API_URL}/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_id: Number(newBranch.brandId), name: newBranch.name })
      });
      if (res.ok) {
        setNewBranch({ brandId: '', name: '' });
        fetchAllData();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error(err);
    }
  };

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProduct.brandId || !newProduct.name) return;
    try {
      const productNameFieldId = (Array.isArray(fields) ? fields : []).find(f => f.name_en === 'Product Name (EN)')?.id || 3;
      
      const res = await fetchWithAuth(`${API_URL}/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          brand_id: Number(newProduct.brandId), 
          fieldValues: { [productNameFieldId.toString()]: newProduct.name } 
        })
      });
      if (res.ok) {
        setNewProduct({ brandId: '', name: '' });
        fetchAllData();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error(err);
    }
  };

  const handleAddResp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newResp) return;
    try {
      const res = await fetchWithAuth(`${API_URL}/busy-responsible`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newResp })
      });
      if (res.ok) {
        setNewResp('');
        fetchAllData();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error(err);
    }
  };

  const handleAddReason = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReason.en || !newReason.ar) return;
    try {
      const reasonField = fields.find(f => f.name_en === 'Primary Reason');
      if (!reasonField) return;

      const res = await fetchWithAuth(`${API_URL}/fields/${reasonField.id}/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value_en: newReason.en, value_ar: newReason.ar })
      });
      if (res.ok) {
        setNewReason({ en: '', ar: '' });
        fetchAllData();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error(err);
    }
  };

  const handleDelete = async (type: string, id: number) => {
    setConfirmModal({
      isOpen: true,
      title: lang === 'en' ? 'Confirm Deletion' : 'تأكيد الحذف',
      message: lang === 'en' 
        ? `Are you sure you want to delete this ${type.split('/').pop()}?` 
        : `هل أنت متأكد أنك تريد حذف هذا ${type.split('/').pop()}؟`,
      type,
      onConfirm: async () => {
        try {
          const res = await fetchWithAuth(`${API_URL}/${type}/${id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            fetchAllData();
            setConfirmModal(prev => ({ ...prev, isOpen: false }));
          } else {
            const data = await res.json();
            setErrorAlert({
              isOpen: true,
              message: data.error || `Failed to delete ${type}`
            });
          }
        } catch (err: any) { 
          if (err.isAuthError) return;
          console.error(err);
          setErrorAlert({
            isOpen: true,
            message: "An error occurred while deleting."
          });
        }
      }
    });
  };

  const configTabs = [
    { id: 'brands', label: 'Brands', icon: Globe },
    { id: 'branches', label: 'Branches', icon: MapPin },
    { id: 'products', label: 'Items', icon: Package },
    { id: 'responsible', label: 'Responsible Parties', icon: UserCheck },
    { id: 'reasons', label: 'Primary Reasons', icon: AlertCircle },
  ];

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pb-20">
      <div>
        <h2 className="text-4xl font-black text-zinc-900 dark:text-white tracking-tight mb-2">Hide Item Configuration</h2>
        <p className="text-zinc-500 dark:text-zinc-400 font-medium">Manage the data used in the Hide Item form.</p>
      </div>

      <div className="flex flex-wrap gap-2 p-1.5 bg-zinc-100 dark:bg-zinc-900 rounded-2xl w-fit border border-zinc-200 dark:border-zinc-800 shadow-inner">
        {configTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => { setActiveConfig(tab.id as any); setSearch(''); }}
            className={cn(
              "flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all",
              activeConfig === tab.id 
                ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300"
            )}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        confirmText={lang === 'en' ? 'Delete' : 'حذف'}
        cancelText={lang === 'en' ? 'Cancel' : 'إلغاء'}
        lang={lang}
      />

      <AnimatePresence>
        {errorAlert.isOpen && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl p-8 max-w-sm w-full shadow-2xl border border-zinc-200 dark:border-zinc-800 text-center"
            >
              <div className="w-16 h-16 bg-red-50 dark:bg-red-900/20 text-red-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <AlertTriangle size={32} />
              </div>
              <h3 className="text-xl font-black text-zinc-900 dark:text-white mb-2">
                {lang === 'en' ? 'Error' : 'خطأ'}
              </h3>
              <p className="text-zinc-500 dark:text-zinc-400 mb-6 font-medium">
                {errorAlert.message}
              </p>
              <button
                onClick={() => setErrorAlert({ isOpen: false, message: '' })}
                className="w-full py-3 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-xl font-bold hover:opacity-90 transition-opacity"
              >
                {lang === 'en' ? 'Close' : 'إغلاق'}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Form Section */}
        <div className="xl:col-span-4 space-y-6">
          <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 p-8 shadow-sm">
            <h3 className="text-xl font-bold text-zinc-900 dark:text-white mb-6 flex items-center gap-2">
              <Plus size={20} className="text-blue-500" />
              Add New {configTabs.find(t => t.id === activeConfig)?.label.slice(0, -1)}
            </h3>

            {activeConfig === 'brands' && (
              <form onSubmit={handleAddBrand} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Brand Name</label>
                  <input 
                    type="text"
                    value={newBrand}
                    onChange={(e) => setNewBrand(e.target.value)}
                    placeholder="Enter brand name..."
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <button className="w-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 py-4 rounded-xl font-bold hover:opacity-90 transition-opacity shadow-lg shadow-zinc-900/10">
                  Add Brand
                </button>
              </form>
            )}

            {activeConfig === 'branches' && (
              <form onSubmit={handleAddBranch} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Select Brand</label>
                  <select 
                    value={newBranch.brandId}
                    onChange={(e) => setNewBranch({ ...newBranch, brandId: e.target.value })}
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  >
                    <option value="">Select Brand</option>
                    {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Branch Name</label>
                  <input 
                    type="text"
                    value={newBranch.name}
                    onChange={(e) => setNewBranch({ ...newBranch, name: e.target.value })}
                    placeholder="Enter branch name..."
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <button className="w-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 py-4 rounded-xl font-bold hover:opacity-90 transition-opacity shadow-lg shadow-zinc-900/10">
                  Add Branch
                </button>
              </form>
            )}

            {activeConfig === 'products' && (
              <form onSubmit={handleAddProduct} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Select Brand</label>
                  <select 
                    value={newProduct.brandId}
                    onChange={(e) => setNewProduct({ ...newProduct, brandId: e.target.value })}
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  >
                    <option value="">Select Brand</option>
                    {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Item Name</label>
                  <input 
                    type="text"
                    value={newProduct.name}
                    onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })}
                    placeholder="Enter item name..."
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <button className="w-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 py-4 rounded-xl font-bold hover:opacity-90 transition-opacity shadow-lg shadow-zinc-900/10">
                  Add Item
                </button>
              </form>
            )}

            {activeConfig === 'responsible' && (
              <form onSubmit={handleAddResp} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Party Name</label>
                  <input 
                    type="text"
                    value={newResp}
                    onChange={(e) => setNewResp(e.target.value)}
                    placeholder="Enter responsible party name..."
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <button className="w-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 py-4 rounded-xl font-bold hover:opacity-90 transition-opacity shadow-lg shadow-zinc-900/10">
                  Add Party
                </button>
              </form>
            )}

            {activeConfig === 'reasons' && (
              <form onSubmit={handleAddReason} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Reason (EN)</label>
                  <input 
                    type="text"
                    value={newReason.en}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (/^[a-zA-Z0-9\s]*$/.test(val)) {
                        setNewReason({ ...newReason, en: val });
                      }
                    }}
                    placeholder="Supply Chain Delay"
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Reason (AR)</label>
                  <input 
                    type="text"
                    value={newReason.ar}
                    onChange={(e) => setNewReason({ ...newReason, ar: e.target.value })}
                    placeholder="تأخير في التوريد"
                    className="w-full bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all text-right"
                  />
                </div>
                <button className="w-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 py-4 rounded-xl font-bold hover:opacity-90 transition-opacity shadow-lg shadow-zinc-900/10">
                  Add Reason
                </button>
              </form>
            )}
          </div>
        </div>

        {/* List Section */}
        <div className="xl:col-span-8 space-y-4">
          <div className="relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors" size={18} />
            <input 
              type="text"
              placeholder={`Search ${activeConfig}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-sm focus:ring-2 focus:ring-blue-500 transition-all outline-none shadow-sm"
            />
          </div>

          <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden">
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-950 z-10 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-8 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Name</th>
                    {activeConfig !== 'brands' && activeConfig !== 'responsible' && (
                      <th className="px-8 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Brand</th>
                    )}
                    <th className="px-8 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  <AnimatePresence mode="popLayout">
                    {(() => {
                      let items: any[] = [];
                      if (activeConfig === 'brands') items = brands;
                      else if (activeConfig === 'branches') items = branches;
                      else if (activeConfig === 'products') items = products;
                      else if (activeConfig === 'responsible') items = responsible;
                      else if (activeConfig === 'reasons') {
                        items = fields.find(f => f.name_en === 'Primary Reason')?.options || [];
                      }

                      const filtered = items.filter(item => {
                        const name = item.name || item.product_name || item.value_en || '';
                        return name.toLowerCase().includes(search.toLowerCase());
                      });

                      if (filtered.length === 0) {
                        return (
                          <tr>
                            <td colSpan={3} className="px-8 py-20 text-center text-zinc-400">
                              No {activeConfig} found.
                            </td>
                          </tr>
                        );
                      }

                      return filtered.map(item => (
                        <motion.tr 
                          key={item.id}
                          layout
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="group hover:bg-zinc-50 dark:hover:bg-zinc-950/50 transition-colors"
                        >
                          <td className="px-8 py-4">
                            <span className="text-sm font-bold text-zinc-900 dark:text-white">
                              {item.name || item.product_name || (lang === 'en' ? item.value_en : item.value_ar)}
                            </span>
                          </td>
                          {activeConfig !== 'brands' && activeConfig !== 'responsible' && activeConfig !== 'reasons' && (
                            <td className="px-8 py-4">
                              <span className="text-xs font-medium px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-lg">
                                {brands.find(b => b.id === item.brand_id)?.name || 'N/A'}
                              </span>
                            </td>
                          )}
                          <td className="px-8 py-4 text-right">
                            <button 
                              onClick={() => {
                                if (activeConfig === 'reasons') {
                                  handleDelete('fields/options', item.id);
                                } else {
                                  handleDelete(activeConfig === 'responsible' ? 'busy-responsible' : activeConfig, item.id);
                                }
                              }}
                              className="p-2 text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all opacity-40 group-hover:opacity-100"
                            >
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </motion.tr>
                      ));
                    })()}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
