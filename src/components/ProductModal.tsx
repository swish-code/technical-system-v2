import React, { useState, useEffect } from 'react';
import { X, Save, Plus, Trash2, GripVertical, Info, Package, Globe, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Product, Brand, DynamicField, ProductFieldValue } from '../types';
import { API_URL, cn } from '../lib/utils';
import { useAuth } from '../context/AuthContext';

interface ProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingProduct: Product | null;
  brands: Brand[];
  fields: DynamicField[];
  onSuccess: () => void;
}

const CHANNELS = [
  'Talabat', 'Keeta', 'Jahez', 'Deliveroo', 'Call Center', 'Web Site', 'Walk In', 'V-thru'
];

import { useFetch } from '../hooks/useFetch';

export default function ProductModal({ isOpen, onClose, editingProduct, brands, fields, onSuccess }: ProductModalProps) {
  const { lang, user } = useAuth();
  const { fetchWithAuth } = useFetch();
  const isRestaurant = user?.role_name === 'Restaurants';
  const [formData, setFormData] = useState<{
    brand_id: string;
    values: Record<number, string>;
    modifierGroups: any[];
    channels: string[];
  }>({
    brand_id: '',
    values: {},
    modifierGroups: [],
    channels: []
  });

  useEffect(() => {
    if (editingProduct) {
      const values: Record<number, string> = {};
      // We need to pass fieldValues as well or fetch them
      // For now, let's assume they are part of the product or we fetch them here
      fetchFieldValues(editingProduct.id);
      
      setFormData({
        brand_id: editingProduct.brand_id.toString(),
        values: {}, // Will be populated by fetchFieldValues
        modifierGroups: (editingProduct as any).modifierGroups || [],
        channels: editingProduct.channels || []
      });
    } else {
      setFormData({ brand_id: '', values: {}, modifierGroups: [], channels: [] });
    }
  }, [editingProduct]);

  useEffect(() => {
    if (!editingProduct && Array.isArray(brands) && brands.length === 1) {
      setFormData(prev => ({ ...prev, brand_id: brands[0].id.toString() }));
    }
  }, [brands, editingProduct]);

  const fetchFieldValues = async (productId: number) => {
    try {
      const res = await fetchWithAuth(`${API_URL}/products`);
      const data = await res.json();
      const productValues = data.fieldValues.filter((fv: any) => fv.product_id === productId);
      const valuesMap: Record<number, string> = {};
      productValues.forEach((fv: any) => {
        valuesMap[fv.field_id] = fv.value;
      });
      setFormData(prev => ({ ...prev, values: valuesMap }));
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Error fetching field values:", err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editingProduct ? 'PUT' : 'POST';
    const url = editingProduct ? `${API_URL}/products/${editingProduct.id}` : `${API_URL}/products`;

    try {
      const res = await fetchWithAuth(url, {
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          brand_id: parseInt(formData.brand_id),
          fieldValues: formData.values,
          modifierGroups: formData.modifierGroups,
          channels: formData.channels
        })
      });

      if (res.ok) {
        onSuccess();
        onClose();
      }
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Error submitting product:", err);
    }
  };

  const addModifierGroup = () => {
    setFormData({
      ...formData,
      modifierGroups: [
        ...formData.modifierGroups,
        { name_en: '', name_ar: '', selection_type: 'single', is_required: false, min_selection: 0, max_selection: 1, options: [] }
      ]
    });
  };

  const removeModifierGroup = (index: number) => {
    const newGroups = [...formData.modifierGroups];
    newGroups.splice(index, 1);
    setFormData({ ...formData, modifierGroups: newGroups });
  };

  const addOption = (groupIndex: number) => {
    const newGroups = [...formData.modifierGroups];
    newGroups[groupIndex].options.push({ name_en: '', name_ar: '', price_adjustment: 0 });
    setFormData({ ...formData, modifierGroups: newGroups });
  };

  const removeOption = (groupIndex: number, optionIndex: number) => {
    const newGroups = [...formData.modifierGroups];
    newGroups[groupIndex].options.splice(optionIndex, 1);
    setFormData({ ...formData, modifierGroups: newGroups });
  };

  const toggleChannel = (channel: string) => {
    const newChannels = formData.channels.includes(channel)
      ? formData.channels.filter(c => c !== channel)
      : [...formData.channels, channel];
    setFormData({ ...formData, channels: newChannels });
  };

  const renderField = (field: DynamicField) => {
    const value = formData.values[field.id] || '';
    
    return (
      <div key={field.id} className="space-y-2">
        <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">
          {lang === 'en' ? field.name_en : field.name_ar}
          {!!field.is_mandatory && <span className="text-brand ml-1">*</span>}
        </label>
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          required={!!field.is_mandatory}
          autoFocus={isRestaurant && field.name_en === 'Ingredients'}
          value={value}
          onChange={(e) => setFormData({
            ...formData,
            values: { ...formData.values, [field.id]: e.target.value }
          })}
          className="w-full px-6 py-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none transition-all font-bold text-zinc-900 dark:text-white shadow-sm"
          placeholder={`Enter ${field.name_en}...`}
        />
      </div>
    );
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
          >
            <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
              <div className="p-8 border-b border-zinc-100 dark:border-zinc-800 flex justify-between items-center bg-zinc-50/50 dark:bg-zinc-800/50 shrink-0">
                <div>
                  <h3 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                    {isRestaurant ? (lang === 'en' ? 'Edit Product Details' : 'تعديل بيانات المنتج') : (editingProduct ? 'Edit' : 'Add New')} 
                    <span className="text-brand">
                      {isRestaurant ? (
                        editingProduct ? ` - ${formData.values[fields.find(f => f.name_en === 'Product Name (EN)')?.id || 0] || ''}` : ''
                      ) : ' Product'}
                    </span>
                  </h3>
                  <p className="text-zinc-500 dark:text-zinc-400 text-sm font-medium">{isRestaurant ? (lang === 'en' ? 'Update ingredients' : 'تحديث المكونات') : 'Configure product details, modifiers and availability'}</p>
                </div>
                <button type="button" onClick={onClose} className="w-12 h-12 flex items-center justify-center bg-white dark:bg-zinc-900 hover:bg-red-500 hover:text-white rounded-2xl transition-all shadow-sm border border-zinc-100 dark:border-zinc-800">
                  <X size={24} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-10 space-y-12 custom-scrollbar">
                {/* Brand Selection */}
                {!isRestaurant && (
                  <section className="space-y-6">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-brand/10 text-brand flex items-center justify-center text-xs font-black">1</div>
                      <h4 className="text-xs font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">Brand Identity</h4>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Select Brand</label>
                        <select
                          required
                          value={formData.brand_id}
                          onChange={(e) => setFormData({ ...formData, brand_id: e.target.value })}
                          className="w-full px-6 py-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none transition-all font-bold text-zinc-900 dark:text-white shadow-sm appearance-none"
                        >
                          <option value="">Choose a brand...</option>
                          {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </section>
                )}

                {/* Dynamic Fields */}
                <section className="space-y-6">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-brand/10 text-brand flex items-center justify-center text-xs font-black">{isRestaurant ? '1' : '2'}</div>
                    <h4 className="text-xs font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">{isRestaurant ? (lang === 'en' ? 'Product Details' : 'بيانات المنتج') : 'Product Specifications'}</h4>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {fields.filter(f => !isRestaurant || f.name_en === 'Ingredients').map(renderField)}
                  </div>
                </section>

                {/* Channels */}
                {!isRestaurant && (
                  <section className="space-y-6">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl bg-brand/10 text-brand flex items-center justify-center text-xs font-black">3</div>
                      <h4 className="text-xs font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">Channel Availability</h4>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {CHANNELS.map(channel => (
                        <button
                          key={channel}
                          type="button"
                          onClick={() => toggleChannel(channel)}
                          className={cn(
                            "px-6 py-3 rounded-2xl text-xs font-black uppercase tracking-widest transition-all border-2",
                            formData.channels.includes(channel)
                              ? "bg-brand border-brand text-white shadow-lg shadow-brand/20"
                              : "bg-zinc-50 dark:bg-zinc-800 border-transparent text-zinc-400 hover:border-zinc-200 dark:hover:border-zinc-700"
                          )}
                        >
                          {channel}
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {/* Modifiers */}
                {!isRestaurant && (
                  <section className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-brand/10 text-brand flex items-center justify-center text-xs font-black">4</div>
                        <h4 className="text-xs font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.2em]">Modifier Groups</h4>
                      </div>
                      <button
                        type="button"
                        onClick={addModifierGroup}
                        className="flex items-center gap-2 text-brand font-black text-[10px] uppercase tracking-widest hover:bg-brand/5 px-4 py-2 rounded-xl transition-all"
                      >
                        <Plus size={14} /> Add Group
                      </button>
                    </div>

                    <div className="space-y-8">
                      {formData.modifierGroups.map((group, gIndex) => (
                        <div key={gIndex} className="bg-zinc-50/50 dark:bg-zinc-800/50 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 overflow-hidden">
                          <div className="p-8 border-b border-zinc-100 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-6">
                            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6">
                              <input
                                placeholder="Group Name (EN)"
                                className="bg-white dark:bg-zinc-900 px-6 py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 outline-none focus:border-brand font-bold"
                                value={group.name_en}
                                onChange={(e) => {
                                  const newGroups = [...formData.modifierGroups];
                                  newGroups[gIndex].name_en = e.target.value;
                                  setFormData({ ...formData, modifierGroups: newGroups });
                                }}
                              />
                              <input
                                placeholder="Group Name (AR)"
                                className="bg-white dark:bg-zinc-900 px-6 py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 outline-none focus:border-brand font-bold text-right"
                                value={group.name_ar}
                                onChange={(e) => {
                                  const newGroups = [...formData.modifierGroups];
                                  newGroups[gIndex].name_ar = e.target.value;
                                  setFormData({ ...formData, modifierGroups: newGroups });
                                }}
                              />
                            </div>
                            <div className="flex items-center gap-4">
                              <select
                                className="bg-white dark:bg-zinc-900 px-4 py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 font-bold text-xs"
                                value={group.selection_type}
                                onChange={(e) => {
                                  const newGroups = [...formData.modifierGroups];
                                  newGroups[gIndex].selection_type = e.target.value;
                                  setFormData({ ...formData, modifierGroups: newGroups });
                                }}
                              >
                                <option value="single">Single Selection</option>
                                <option value="multiple">Multiple Selection</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => removeModifierGroup(gIndex)}
                                className="p-3 text-red-500 hover:bg-red-50 rounded-xl transition-all"
                              >
                                <Trash2 size={18} />
                              </button>
                            </div>
                          </div>

                          <div className="p-8 space-y-4">
                            {group.options.map((option: any, oIndex: number) => (
                              <div key={oIndex} className="flex flex-wrap items-center gap-4 bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-zinc-100 dark:border-zinc-800 shadow-sm">
                                <GripVertical className="text-zinc-300" size={18} />
                                <input
                                  placeholder="Option EN"
                                  className="flex-1 min-w-[150px] bg-transparent outline-none font-bold"
                                  value={option.name_en}
                                  onChange={(e) => {
                                    const newGroups = [...formData.modifierGroups];
                                    newGroups[gIndex].options[oIndex].name_en = e.target.value;
                                    setFormData({ ...formData, modifierGroups: newGroups });
                                  }}
                                />
                                <input
                                  placeholder="Option AR"
                                  className="flex-1 min-w-[150px] bg-transparent outline-none font-bold text-right"
                                  value={option.name_ar}
                                  onChange={(e) => {
                                    const newGroups = [...formData.modifierGroups];
                                    newGroups[gIndex].options[oIndex].name_ar = e.target.value;
                                    setFormData({ ...formData, modifierGroups: newGroups });
                                  }}
                                />
                                <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800 px-4 py-2 rounded-xl border border-zinc-100 dark:border-zinc-700">
                                  <span className="text-[10px] font-black text-zinc-400">KD</span>
                                  <input
                                    type="number"
                                    step="0.001"
                                    className="w-20 bg-transparent outline-none font-mono font-bold text-emerald-600"
                                    value={option.price_adjustment}
                                    onChange={(e) => {
                                      const newGroups = [...formData.modifierGroups];
                                      newGroups[gIndex].options[oIndex].price_adjustment = parseFloat(e.target.value);
                                      setFormData({ ...formData, modifierGroups: newGroups });
                                    }}
                                  />
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removeOption(gIndex, oIndex)}
                                  className="p-2 text-zinc-300 hover:text-red-500 transition-all"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              onClick={() => addOption(gIndex)}
                              className="w-full py-4 border-2 border-dashed border-zinc-200 dark:border-zinc-800 rounded-2xl text-zinc-400 font-bold hover:border-brand hover:text-brand transition-all flex items-center justify-center gap-2 text-sm"
                            >
                              <Plus size={16} /> Add Option
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>

              <div className="p-8 bg-zinc-50 dark:bg-zinc-800/50 border-t border-zinc-100 dark:border-zinc-800 flex justify-end gap-4 shrink-0">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-8 py-4 rounded-2xl font-black text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all uppercase tracking-widest text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary flex items-center gap-3 px-12"
                >
                  <Save size={20} />
                  {isRestaurant ? (lang === 'en' ? 'Update Product' : 'تحديث المنتج') : (editingProduct ? 'Update Product' : 'Create Product')}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
