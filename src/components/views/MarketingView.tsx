import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, safeJson } from '../../lib/utils';
import ProductModal from '../ProductModal';
import { Plus, Package } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Brand, Product, DynamicField, FieldOption, ProductFieldValue } from '../../types';
import { useWebSocket } from '../../hooks/useWebSocket';

import { useFetch } from '../../hooks/useFetch';

export default function MarketingView() {
  const { lang, user, logout } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [products, setProducts] = useState<Product[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [fields, setFields] = useState<DynamicField[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const lastMessage = useWebSocket();

  const fetchData = async () => {
    try {
      const [pRes, bRes, fRes] = await Promise.all([
        fetchWithAuth(`${API_URL}/products`),
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

      const pData = await safeJson(pRes);
      const bData = await safeJson(bRes);
      const fData = await safeJson(fRes);

      if (!pData || !bData || !fData) {
        throw new Error("Failed to parse initial data");
      }

      const currentFields = fData.fields || [];
      const productNameFieldId = currentFields.find((f: any) => f.name_en === (lang === 'en' ? 'Product Name (EN)' : 'Product Name (AR)'))?.id || (lang === 'en' ? 3 : 7);

      // Create a map for faster lookups
      const nameMap = new Map();
      if (pData.fieldValues) {
        pData.fieldValues.forEach((fv: any) => {
          if (fv.field_id === productNameFieldId) {
            nameMap.set(fv.product_id, fv.value);
          }
        });
      }

      const mappedProducts = (pData.products || []).map((p: any) => {
        return { ...p, name: nameMap.get(p.id) || (lang === 'en' ? 'Unnamed Product' : 'منتج بدون اسم') };
      });

      setProducts(mappedProducts);
      setBrands(bData || []);
      setFields(currentFields);
    } catch (err: any) {
      if (err.isAuthError) return;
      console.error("Failed to fetch marketing data", err);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'PRODUCT_CREATED' || lastMessage?.type === 'PRODUCT_UPDATED') {
      fetchData();
    }
  }, [lastMessage]);

  return (
    <div className="space-y-6 pb-20">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-3xl font-display font-black text-zinc-900 dark:text-white tracking-tight">
            Marketing <span className="text-brand">Dashboard</span>
          </h2>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium text-sm mt-0.5">Add and manage your professional product catalog</p>
        </div>
        {user?.role_name !== 'Restaurants' && (
          <button 
            onClick={() => {
              setEditingProduct(null);
              setIsModalOpen(true);
            }}
            className="btn-primary flex items-center gap-2 px-6 py-2.5 text-sm group"
          >
            <div className="w-5 h-5 bg-white/20 rounded-lg flex items-center justify-center group-hover:rotate-90 transition-transform duration-500">
              <Plus size={16} />
            </div>
            Add New Product
          </button>
        )}
      </div>

      {/* Product grid removed as requested */}

      <ProductModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        editingProduct={editingProduct}
        brands={brands}
        fields={fields}
        onSuccess={fetchData}
      />
    </div>
  );
}
