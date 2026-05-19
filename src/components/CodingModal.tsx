import React, { useState, useEffect } from 'react';
import { X, Save, Package, ListTree, Tag, RefreshCw, CheckCircle2, Layers } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Product } from '../types';
import { API_URL, cn } from '../lib/utils';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../hooks/useFetch';

interface CodingModalProps {
  isOpen: boolean;
  onClose: () => void;
  product: Product | null;
  onSuccess: () => void;
}

export default function CodingModal({ isOpen, onClose, product, onSuccess }: CodingModalProps) {
  const { lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [localProduct, setLocalProduct] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (product) {
      setLocalProduct(JSON.parse(JSON.stringify(product)));
    } else {
      setLocalProduct(null);
    }
  }, [product]);

  const handleUpdateProductCode = (value: string) => {
    if (!localProduct) return;
    setLocalProduct({ ...localProduct, product_code: value });
  };

  const handleUpdateGroupCode = (groupId: number, value: string) => {
    if (!localProduct) return;
    const newGroups = localProduct.modifierGroups?.map(g => 
      g.id === groupId ? { ...g, code: value } : g
    );
    setLocalProduct({ ...localProduct, modifierGroups: newGroups });
  };

  const handleUpdateOptionCode = (groupId: number, optionId: number, value: string) => {
    if (!localProduct) return;
    const newGroups = localProduct.modifierGroups?.map(g => {
      if (g.id === groupId) {
        const newOptions = g.options.map(o => 
          o.id === optionId ? { ...o, code: value } : o
        );
        return { ...g, options: newOptions };
      }
      return g;
    });
    setLocalProduct({ ...localProduct, modifierGroups: newGroups });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localProduct) return;

    setSaving(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/products/${localProduct.id}/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          productCode: localProduct.product_code,
          modifierGroups: localProduct.modifierGroups
        }),
      });
      if (res.ok) {
        setShowSuccess(true);
        onSuccess();
        setTimeout(() => {
          setShowSuccess(false);
          onClose();
        }, 1500);
      }
    } catch (error) {
      console.error("Save error:", error);
    } finally {
      setSaving(false);
    }
  };

  const t = {
    en: {
      title: "PLU",
      save: "Save All PLUs",
      saving: "Saving...",
      productCode: "PLU",
      modifierCode: "Modifier PLU",
      optionCode: "Option PLU",
      enterCode: "Enter PLU",
      success: "Saved successfully",
      cancel: "Cancel"
    },
    ar: {
      title: "PLU",
      save: "حفظ جميع الـ PLUs",
      saving: "جاري الحفظ...",
      productCode: "PLU",
      modifierCode: "PLU المودفاير",
      optionCode: "PLU الخيار",
      enterCode: "أدخل الـ PLU",
      success: "تم الحفظ بنجاح",
      cancel: "إلغاء"
    }
  }[lang];

  if (!localProduct) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
          >
            <form onSubmit={handleSave} className="flex-1 flex flex-col min-h-0">
              <div className="p-6 border-b border-zinc-100 dark:border-zinc-800 flex justify-between items-center bg-zinc-50/50 dark:bg-zinc-800/50 shrink-0">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-brand flex items-center justify-center text-white shadow-lg shadow-brand/20">
                    <Package size={24} />
                  </div>
                  <div>
                    <h3 className="text-2xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
                      {t.title}
                    </h3>
                    <p className="text-zinc-500 dark:text-zinc-400 text-xs font-bold uppercase tracking-widest">{localProduct.brand_name}</p>
                  </div>
                </div>
                <button type="button" onClick={onClose} className="w-10 h-10 flex items-center justify-center hover:bg-red-500 hover:text-white rounded-xl transition-all">
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                {/* Product Code */}
                <section className="space-y-4">
                  <div className="flex items-center gap-2 text-brand">
                    <Package size={18} />
                    <h4 className="text-sm font-black uppercase tracking-widest">{t.productCode}</h4>
                  </div>
                  <input
                    type="text"
                    required
                    placeholder={t.enterCode}
                    className="w-full px-6 py-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800 border-2 border-transparent focus:border-brand outline-none transition-all font-mono font-bold text-zinc-900 dark:text-white shadow-sm"
                    value={localProduct.product_code || ''}
                    onChange={(e) => handleUpdateProductCode(e.target.value)}
                  />
                </section>

                {/* Modifiers */}
                {localProduct.modifierGroups && localProduct.modifierGroups.length > 0 && (
                  <section className="space-y-6">
                    <div className="flex items-center gap-2 text-brand">
                      <ListTree size={18} />
                      <h4 className="text-sm font-black uppercase tracking-widest">{lang === 'en' ? 'Modifiers & Options' : 'المودفاير والخيارات'}</h4>
                    </div>
                    <div className="space-y-6">
                      {localProduct.modifierGroups.map((group) => (
                        <div key={group.id} className="bg-zinc-50/50 dark:bg-zinc-800/50 rounded-2xl border border-zinc-100 dark:border-zinc-800 overflow-hidden">
                          <div className="p-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-white dark:bg-zinc-900 flex items-center justify-center text-zinc-400">
                                <Layers size={16} />
                              </div>
                              <span className="font-bold text-zinc-900 dark:text-white text-sm">{lang === 'en' ? group.name_en : group.name_ar}</span>
                            </div>
                            <input
                              type="text"
                              required
                              placeholder={t.modifierCode}
                              className="w-32 px-3 py-2 rounded-lg border-2 border-transparent focus:border-brand bg-white dark:bg-zinc-900 outline-none text-xs font-mono font-bold transition-all"
                              value={group.code || ''}
                              onChange={(e) => handleUpdateGroupCode(group.id, e.target.value)}
                            />
                          </div>
                          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {group.options.map((option) => (
                              <div key={option.id} className="flex items-center justify-between gap-3 bg-white dark:bg-zinc-900 p-3 rounded-xl border border-zinc-100 dark:border-zinc-800">
                                <div className="flex items-center gap-2">
                                  <Tag size={14} className="text-zinc-300" />
                                  <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">{lang === 'en' ? option.name_en : option.name_ar}</span>
                                </div>
                                <input
                                  type="text"
                                  required
                                  placeholder={t.optionCode}
                                  className="w-24 px-2 py-1.5 rounded-lg border-2 border-zinc-50 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-white focus:border-brand outline-none text-[10px] font-mono font-bold transition-all"
                                  value={option.code || ''}
                                  onChange={(e) => handleUpdateOptionCode(group.id, option.id, e.target.value)}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>

              <div className="p-6 bg-zinc-50 dark:bg-zinc-800/50 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  {showSuccess && (
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-2 text-emerald-500 font-bold text-sm"
                    >
                      <CheckCircle2 size={16} />
                      <span>{t.success}</span>
                    </motion.div>
                  )}
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-6 py-3 rounded-xl font-bold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all text-sm"
                  >
                    {t.cancel}
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="btn-primary flex items-center gap-2 px-8 py-3 text-sm"
                  >
                    {saving ? (
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
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
