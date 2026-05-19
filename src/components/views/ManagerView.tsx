import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { API_URL, cn, formatDate } from '../../lib/utils';
import { Plus, UserPlus, Shield, Globe, Settings, History, Trash2, Edit2, Check, X, User as UserIcon, Lock, Briefcase, MapPin, Building2, AlertCircle, RefreshCw, AlertTriangle } from 'lucide-react';
import { User, Brand, DynamicField, AuditLog, FieldOption } from '../../types';
import { CallCenterConfigView } from './CallCenterConfigView';
import { motion, AnimatePresence } from 'motion/react';
import ConfirmModal from '../ConfirmModal';

import { useFetch } from '../../hooks/useFetch';

export default function ManagerView({ activeTab }: { activeTab: string }) {
  const { lang } = useAuth();
  const { fetchWithAuth } = useFetch();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<{id: number, name: string}[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [fields, setFields] = useState<DynamicField[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>([]);
  const [busyBranches, setBusyBranches] = useState<any[]>([]);
  const [busyReasons, setBusyReasons] = useState<any[]>([]);
  const [busyResponsible, setBusyResponsible] = useState<any[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isOptionsModalOpen, setIsOptionsModalOpen] = useState(false);
  const [selectedField, setSelectedField] = useState<DynamicField | null>(null);
  const [modalType, setModalType] = useState<'user' | 'brand' | 'field'>('user');
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editingField, setEditingField] = useState<DynamicField | null>(null);
  const [formData, setFormData] = useState<any>({});
  const [newOption, setNewOption] = useState({ value_en: '', value_ar: '', price: '0' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {}
  });

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === 'users') {
        const [uRes, rRes, bRes, brRes] = await Promise.all([
          fetchWithAuth(`${API_URL}/users`),
          fetchWithAuth(`${API_URL}/roles`),
          fetchWithAuth(`${API_URL}/brands`),
          fetchWithAuth(`${API_URL}/branches?all=true`)
        ]);
        
        if (!uRes.ok) throw new Error(`Failed to fetch users: ${uRes.status}`);
        if (!rRes.ok) throw new Error(`Failed to fetch roles: ${rRes.status}`);
        if (!bRes.ok) throw new Error(`Failed to fetch brands: ${bRes.status}`);
        if (!brRes.ok) throw new Error(`Failed to fetch branches: ${brRes.status}`);
        
        const uData = await uRes.json();
        const rData = await rRes.json();
        const bData = await bRes.json();
        const brData = await brRes.json();

        setUsers(Array.isArray(uData) ? uData : []);
        setRoles(Array.isArray(rData) ? rData : []);
        setBrands(Array.isArray(bData) ? bData : []);
        setBranches(Array.isArray(brData) ? brData : []);
      } else if (activeTab === 'fields') {
        const res = await fetchWithAuth(`${API_URL}/fields`);
        if (!res.ok) throw new Error(`Failed to fetch fields: ${res.status}`);
        const data = await res.json();
        setFields(Array.isArray(data.fields) ? data.fields : []);
        setFieldOptions(Array.isArray(data.options) ? data.options : []);
      } else if (activeTab === 'logs') {
        const res = await fetchWithAuth(`${API_URL}/audit-logs`);
        if (!res.ok) throw new Error(`Failed to fetch audit logs: ${res.status}`);
        const data = await res.json();
        setLogs(Array.isArray(data) ? data : []);
      } else if (activeTab === 'busy_config') {
        const [bRes, rRes, respRes, brandsRes] = await Promise.all([
          fetchWithAuth(`${API_URL}/branches`),
          fetchWithAuth(`${API_URL}/busy-reasons`),
          fetchWithAuth(`${API_URL}/busy-responsible`),
          fetchWithAuth(`${API_URL}/brands`)
        ]);
        
        if (!bRes.ok) throw new Error(`Failed to fetch branches: ${bRes.status}`);
        if (!rRes.ok) throw new Error(`Failed to fetch busy reasons: ${rRes.status}`);
        if (!respRes.ok) throw new Error(`Failed to fetch busy responsible: ${respRes.status}`);
        if (!brandsRes.ok) throw new Error(`Failed to fetch brands: ${brandsRes.status}`);

        const bData = await bRes.json();
        const rData = await rRes.json();
        const respData = await respRes.json();
        const brandsData = await brandsRes.json();
        
        setBusyBranches(Array.isArray(bData) ? bData : []);
        setBusyReasons(Array.isArray(rData) ? rData : []);
        setBusyResponsible(Array.isArray(respData) ? respData : []);
        setBrands(Array.isArray(brandsData) ? brandsData : []);
      }
    } catch (error: any) {
      if (error.isAuthError) return;
      console.error("Error fetching data:", error);
      setError(error.message || 'An unexpected error occurred while fetching data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    const url = editingUser ? `${API_URL}/users/${editingUser.id}` : `${API_URL}/users`;
    const method = editingUser ? 'PUT' : 'POST';
    
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(formData),
    });
    if (res.ok) {
      setIsModalOpen(false);
      setEditingUser(null);
      fetchData();
    }
  };

  const handleCreateBrand = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_URL}/brands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(formData),
    });
    if (res.ok) {
      setIsModalOpen(false);
      setFormData({});
      fetchData();
    }
  };

  const handleSaveField = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    const url = editingField ? `${API_URL}/fields/${editingField.id}` : `${API_URL}/fields`;
    const method = editingField ? 'PUT' : 'POST';
    
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...formData, type: formData.type || 'text' }),
    });
    if (res.ok) {
      setIsModalOpen(false);
      setEditingField(null);
      fetchData();
    }
  };

  const handleDeleteField = async (fieldId: number) => {
    setConfirmModal({
      isOpen: true,
      title: lang === 'en' ? 'Delete Field' : 'حذف الحقل',
      message: lang === 'en' 
        ? 'Are you sure you want to delete this field? This will remove all associated data.' 
        : 'هل أنت متأكد أنك تريد حذف هذا الحقل؟ سيؤدي ذلك إلى إزالة جميع البيانات المرتبطة.',
      onConfirm: async () => {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/fields/${fieldId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          fetchData();
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        } else {
          const data = await res.json();
          setError(data.error || 'Failed to delete field');
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      }
    });
  };

  const handleAddOption = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedField) return;
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_URL}/fields/${selectedField.id}/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...newOption, price: parseFloat(newOption.price) }),
    });
    if (res.ok) {
      setNewOption({ value_en: '', value_ar: '', price: '0' });
      fetchData();
    }
  };

  const handleDeleteOption = async (optionId: number) => {
    await fetchWithAuth(`${API_URL}/fields/options/${optionId}`, {
      method: 'DELETE',
    });
    fetchData();
  };

  const toggleUserStatus = async (user: User) => {
    await fetchWithAuth(`${API_URL}/users/${user.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !user.is_active, role_id: user.role_id }),
    });
    fetchData();
  };

  const handleDeleteUser = async (userId: number) => {
    setConfirmModal({
      isOpen: true,
      title: lang === 'en' ? 'Delete User' : 'حذف المستخدم',
      message: lang === 'en' ? 'Are you sure you want to delete this user?' : 'هل أنت متأكد أنك تريد حذف هذا المستخدم؟',
      onConfirm: async () => {
        const res = await fetchWithAuth(`${API_URL}/users/${userId}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          fetchData();
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        } else {
          const data = await res.json();
          setError(data.error || 'Failed to delete user');
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      }
    });
  };

  const handleDeleteBrand = async (brandId: number) => {
    setConfirmModal({
      isOpen: true,
      title: lang === 'en' ? 'Delete Brand' : 'حذف العلامة التجارية',
      message: lang === 'en' ? 'Are you sure you want to delete this brand?' : 'هل أنت متأكد أنك تريد حذف هذه العلامة التجارية؟',
      onConfirm: async () => {
        const res = await fetchWithAuth(`${API_URL}/brands/${brandId}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          fetchData();
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        } else {
          const data = await res.json();
          setError(data.error || 'Failed to delete brand');
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      }
    });
  };

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
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-zinc-900 dark:text-white capitalize">
          {activeTab === 'busy_config' ? (lang === 'ar' ? 'نموذج الفروع المزدحمة' : 'Busy Branch Form') : 
           activeTab === 'busy_database' ? (lang === 'ar' ? 'قاعدة بيانات الفروع المزدحمة' : 'Busy Branch Database') :
           activeTab === 'fields' ? (lang === 'ar' ? 'نموذج المنتجات' : 'Form Products') :
           activeTab === 'call_center_config' ? (lang === 'ar' ? 'إعدادات الكول سنتر' : 'Call Center Config') :
           activeTab.replace('_', ' ')}
        </h2>
        {(activeTab === 'users' || activeTab === 'fields') && (
          <button 
            onClick={() => {
              setModalType(activeTab === 'users' ? 'user' : 'field');
              setEditingUser(null);
              setEditingField(null);
              setFormData({});
              setIsModalOpen(true);
            }}
            className="bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-6 py-2 rounded-xl font-semibold flex items-center gap-2 hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors"
          >
            <Plus size={20} />
            Add New
          </button>
        )}
      </div>

      {activeTab === 'users' && (
        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
              <tr>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Username</th>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Role</th>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Assigned Brand/Branch</th>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Status</th>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {users.map(u => (
                <tr key={u.id}>
                  <td className="px-6 py-4 font-medium text-zinc-900 dark:text-white">{u.username}</td>
                  <td className="px-6 py-4 text-zinc-500 dark:text-zinc-400">{u.role_name}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1">
                      {u.brand_names && u.brand_names.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {u.brand_names.map(name => (
                            <span key={name} className="px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold">
                              {name}
                            </span>
                          ))}
                        </div>
                      ) : u.brand_name ? (
                        <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                          {u.brand_name}
                        </span>
                      ) : (
                        <span className="text-sm text-zinc-400 italic">All Brands</span>
                      )}
                      {u.branch_names && u.branch_names.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {u.branch_names.map(name => (
                            <span key={name} className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
                              {name}
                            </span>
                          ))}
                        </div>
                      ) : u.branch_name && (
                        <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
                          {u.branch_name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={cn(
                      "px-3 py-1 rounded-full text-xs font-bold",
                      u.is_active ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400"
                    )}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right flex justify-end gap-2">
                    <button 
                      onClick={() => {
                        setEditingUser(u);
                        setModalType('user');
                        setFormData({ 
                          username: u.username, 
                          role_id: u.role_id, 
                          is_active: u.is_active,
                          brand_id: u.brand_id,
                          branch_id: u.branch_id,
                          brand_ids: u.brand_ids || []
                        });
                        setIsModalOpen(true);
                      }}
                      className="p-2 text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                    >
                      <Edit2 size={18} />
                    </button>
                    <button 
                      onClick={() => toggleUserStatus(u)}
                      className={cn(
                        "p-2 rounded-lg transition-colors",
                        u.is_active ? "text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10" : "text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10"
                      )}
                      title={u.is_active ? "Deactivate User" : "Activate User"}
                    >
                      {u.is_active ? <X size={18} /> : <Check size={18} />}
                    </button>
                    <button 
                      onClick={() => handleDeleteUser(u.id)}
                      className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                      title="Delete User"
                    >
                      <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}


      {activeTab === 'fields' && (
        <div className="space-y-4">
          {Array.isArray(fields) && fields.map(f => (
            <div key={f.id} className="bg-white dark:bg-zinc-900 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <p className="font-bold text-zinc-900 dark:text-white">{f.name_en} / {f.name_ar}</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 uppercase font-bold tracking-wider">{f.type} • {f.is_mandatory ? 'Mandatory' : 'Optional'}</p>
                {(f.type === 'dropdown' || f.type === 'multiselect') && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button 
                      onClick={() => {
                        setSelectedField(f);
                        setIsOptionsModalOpen(true);
                      }}
                      className="text-[10px] bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-3 py-1 rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors font-bold uppercase tracking-wider"
                    >
                      Manage Options ({fieldOptions.filter(o => o.field_id === f.id).length})
                    </button>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={() => {
                    setEditingField(f);
                    setModalType('field');
                    setFormData({ name_en: f.name_en, name_ar: f.name_ar, type: f.type, is_mandatory: f.is_mandatory });
                    setIsModalOpen(true);
                  }}
                  className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg text-zinc-500 dark:text-zinc-400"
                >
                  <Edit2 size={18} />
                </button>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteField(f.id);
                  }}
                  className="p-2 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg text-red-500 transition-colors"
                  title="Delete Field"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Audit Logs View */}
      {activeTab === 'logs' && (
        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
              <tr>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">User</th>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Action</th>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Target</th>
                <th className="px-6 py-4 text-sm font-semibold text-zinc-900 dark:text-white">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {logs.map(log => (
                <tr key={log.id}>
                  <td className="px-6 py-4 font-medium text-zinc-900 dark:text-white">{log.username}</td>
                  <td className="px-6 py-4 text-zinc-500 dark:text-zinc-400">
                    <div className="flex flex-col">
                      <span className="font-bold">{log.action}</span>
                      <span className="text-[10px] uppercase tracking-wider opacity-50">{log.target_table}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-zinc-500 dark:text-zinc-400">
                    {(() => {
                      try {
                        const newVal = log.new_value ? JSON.parse(log.new_value) : null;
                        const oldVal = log.old_value ? JSON.parse(log.old_value) : null;
                        
                        if (log.action === 'HIDE' || log.action === 'UNHIDE') {
                          const data = newVal || oldVal;
                          return (
                            <div className="flex flex-col">
                              <span className="text-zinc-900 dark:text-white font-bold">{data?.product_name}</span>
                              <span className="text-[10px] opacity-70">{data?.branch || data?.branches}</span>
                            </div>
                          );
                        }
                        
                        if (log.action === 'CREATE' && log.target_table === 'products') {
                          return <span className="text-zinc-900 dark:text-white font-bold">New Product Created</span>;
                        }

                        return <span className="text-xs opacity-50 italic">No extra details</span>;
                      } catch (e) {
                        return <span className="text-xs opacity-50 italic">Details unavailable</span>;
                      }
                    })()}
                  </td>
                  <td className="px-6 py-4 text-zinc-400 dark:text-zinc-500 text-sm">{formatDate(log.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Busy Branch Configuration View */}
      {activeTab === 'call_center_config' && (
        <CallCenterConfigView />
      )}

      {activeTab === 'busy_config' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 pb-20">
          {/* Brands & Branches - Large Section */}
          <div className="lg:col-span-12 bg-white dark:bg-zinc-900 p-10 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">Brands & Branches</h3>
                <p className="text-zinc-500 dark:text-zinc-400 text-sm font-medium">Manage the hierarchy of brands and their physical locations.</p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
                <Globe size={24} />
              </div>
            </div>
            
            <form onSubmit={async (e) => {
              e.preventDefault();
              const token = localStorage.getItem('token');
              const res = await fetch(`${API_URL}/branches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ brand_id: formData.brand_id, name: formData.branch_name }),
              });
              if (res.ok) {
                setFormData({ ...formData, branch_name: '' });
                fetchData();
              }
            }} className="grid grid-cols-1 md:grid-cols-3 gap-4 p-6 bg-zinc-50 dark:bg-zinc-800/50 rounded-3xl border border-zinc-100 dark:border-zinc-800">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">Select Brand</label>
                <select 
                  className="w-full px-5 py-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white transition-all font-bold text-zinc-900 dark:text-white"
                  value={formData.brand_id || ''}
                  onChange={e => setFormData({ ...formData, brand_id: parseInt(e.target.value) })}
                  required
                >
                  <option value="">Select Brand</option>
                  {Array.isArray(brands) && brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">New Branch Name</label>
                <input 
                  type="text" 
                  placeholder="e.g. Downtown Branch" 
                  className="w-full px-5 py-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white transition-all font-bold text-zinc-900 dark:text-white"
                  value={formData.branch_name || ''}
                  onChange={e => setFormData({ ...formData, branch_name: e.target.value })}
                  required
                />
              </div>
              <div className="flex items-end">
                <button type="submit" className="w-full h-[52px] bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-2xl font-black shadow-xl shadow-zinc-900/20 dark:shadow-white/10 hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all flex items-center justify-center gap-2">
                  <Plus size={20} className="text-amber-400" />
                  Add Branch
                </button>
              </div>
            </form>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {busyBranches.map(b => (
                <motion.div 
                  layout
                  key={b.id} 
                  className="flex items-center justify-between p-4 bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 rounded-2xl shadow-sm hover:shadow-md transition-all group"
                >
                  <div className="flex flex-col">
                    <span className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">{b.brand_name}</span>
                    <span className="font-bold text-zinc-900 dark:text-white">{b.name}</span>
                  </div>
                  <button onClick={async () => {
                    const token = localStorage.getItem('token');
                    const res = await fetch(`${API_URL}/branches/${b.id}`, {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    if (res.ok) fetchData();
                  }} className="p-2 text-zinc-300 dark:text-zinc-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-xl transition-all opacity-0 group-hover:opacity-100">
                    <X size={16} />
                  </button>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Reasons Section */}
          <div className="lg:col-span-6 bg-white dark:bg-zinc-900 p-10 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">Busy Reasons</h3>
                <p className="text-zinc-500 dark:text-zinc-400 text-sm font-medium">Define categories for branch congestion.</p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
                <Shield size={24} />
              </div>
            </div>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const token = localStorage.getItem('token');
              const res = await fetch(`${API_URL}/busy-reasons`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: formData.reason_name }),
              });
              if (res.ok) {
                setFormData({ ...formData, reason_name: '' });
                fetchData();
              }
            }} className="flex gap-3">
              <input 
                type="text" 
                placeholder="New Reason Category" 
                className="flex-1 px-5 py-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold text-zinc-900 dark:text-white"
                value={formData.reason_name || ''}
                onChange={e => setFormData({ ...formData, reason_name: e.target.value })}
                required
              />
              <button type="submit" className="p-3 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-2xl hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all shadow-lg shadow-zinc-900/20 dark:shadow-white/10">
                <Plus size={24} />
              </button>
            </form>
            <div className="space-y-2">
              {busyReasons.map(r => (
                <motion.div 
                  layout
                  key={r.id} 
                  className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-800/50 rounded-2xl border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 transition-all group"
                >
                  <span className="font-bold text-zinc-900 dark:text-white">{r.name}</span>
                  <button onClick={async () => {
                    const token = localStorage.getItem('token');
                    const res = await fetch(`${API_URL}/busy-reasons/${r.id}`, {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    if (res.ok) fetchData();
                  }} className="p-2 text-zinc-300 dark:text-zinc-600 hover:text-red-500 transition-all opacity-0 group-hover:opacity-100">
                    <X size={16} />
                  </button>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Responsible Parties Section */}
          <div className="lg:col-span-6 bg-white dark:bg-zinc-900 p-10 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">Responsible Parties</h3>
                <p className="text-zinc-500 dark:text-zinc-400 text-sm font-medium">Identify groups responsible for handling events.</p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
                <Settings size={24} />
              </div>
            </div>
            <form onSubmit={async (e) => {
              e.preventDefault();
              const token = localStorage.getItem('token');
              const res = await fetch(`${API_URL}/busy-responsible`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: formData.resp_name }),
              });
              if (res.ok) {
                setFormData({ ...formData, resp_name: '' });
                fetchData();
              }
            }} className="flex gap-3">
              <input 
                type="text" 
                placeholder="New Responsible Party" 
                className="flex-1 px-5 py-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold text-zinc-900 dark:text-white"
                value={formData.resp_name || ''}
                onChange={e => setFormData({ ...formData, resp_name: e.target.value })}
                required
              />
              <button type="submit" className="p-3 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-2xl hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all shadow-lg shadow-zinc-900/20 dark:shadow-white/10">
                <Plus size={24} />
              </button>
            </form>
            <div className="space-y-2">
              {busyResponsible.map(r => (
                <motion.div 
                  layout
                  key={r.id} 
                  className="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-800/50 rounded-2xl border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 transition-all group"
                >
                  <span className="font-bold text-zinc-900 dark:text-white">{r.name}</span>
                  <button onClick={async () => {
                    const token = localStorage.getItem('token');
                    const res = await fetch(`${API_URL}/busy-responsible/${r.id}`, {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${token}` },
                    });
                    if (res.ok) fetchData();
                  }} className="text-zinc-400 dark:text-zinc-500 hover:text-red-500 transition-all opacity-0 group-hover:opacity-100">
                    <X size={16} />
                  </button>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Brands Management Section - Moved to Bottom */}
          <div className="lg:col-span-12 bg-white dark:bg-zinc-900 p-10 rounded-[2.5rem] border border-zinc-100 dark:border-zinc-800 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.05)] space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-black text-zinc-900 dark:text-white tracking-tight">Brands Management</h3>
                <p className="text-zinc-500 dark:text-zinc-400 text-sm font-medium">Add and manage your main brand identities.</p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 dark:text-zinc-500">
                <Globe size={24} />
              </div>
            </div>
            
            <form onSubmit={handleCreateBrand} className="flex gap-3">
              <input 
                type="text" 
                placeholder="New Brand Name" 
                className="flex-1 px-5 py-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800 outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold text-zinc-900 dark:text-white"
                value={formData.name || ''}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                required
              />
              <button type="submit" className="p-3 bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 rounded-2xl hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all shadow-lg shadow-zinc-900/20 dark:shadow-white/10">
                <Plus size={24} />
              </button>
            </form>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.isArray(brands) && brands.map(b => (
                <motion.div 
                  layout
                  key={b.id} 
                  className="flex items-center justify-between p-4 bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 rounded-2xl shadow-sm hover:shadow-md transition-all group"
                >
                  <span className="font-bold text-zinc-900 dark:text-white">{b.name}</span>
                  <button 
                    onClick={() => handleDeleteBrand(b.id)}
                    className="p-2 text-zinc-300 dark:text-zinc-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 size={16} />
                  </button>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Options Management Modal */}
      {isOptionsModalOpen && selectedField && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[110] p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white dark:bg-zinc-900 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden border border-zinc-200 dark:border-zinc-800"
          >
            <div className="p-6 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-zinc-900 dark:text-white">Manage Options</h3>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{selectedField.name_en} / {selectedField.name_ar}</p>
              </div>
              <button onClick={() => setIsOptionsModalOpen(false)} className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg text-zinc-500 dark:text-zinc-400">
                <X size={20} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              <form onSubmit={handleAddOption} className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8 bg-zinc-50 dark:bg-zinc-800/50 p-4 rounded-xl border border-zinc-100 dark:border-zinc-800">
                <div className="md:col-span-1">
                  <label className="block text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase mb-1">Name (EN)</label>
                  <input 
                    required
                    placeholder="e.g. Coca Cola"
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-white text-zinc-900 dark:text-white"
                    value={newOption.value_en}
                    onChange={e => setNewOption({ ...newOption, value_en: e.target.value })}
                  />
                </div>
                <div className="md:col-span-1">
                  <label className="block text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase mb-1">Name (AR)</label>
                  <input 
                    required
                    placeholder="كوكا كولا"
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-white text-zinc-900 dark:text-white"
                    value={newOption.value_ar}
                    onChange={e => setNewOption({ ...newOption, value_ar: e.target.value })}
                  />
                </div>
                <div className="md:col-span-1">
                  <label className="block text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase mb-1">Price (KD)</label>
                  <input 
                    type="number"
                    step="0.01"
                    className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-white text-zinc-900 dark:text-white"
                    value={newOption.price}
                    onChange={e => setNewOption({ ...newOption, price: e.target.value })}
                  />
                </div>
                <div className="flex items-end">
                  <button type="submit" className="w-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 py-2 rounded-lg text-sm font-bold hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-colors">
                    Add Option
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                <div className="grid grid-cols-4 px-4 py-2 text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                  <div className="col-span-1">Name (EN)</div>
                  <div className="col-span-1">Name (AR)</div>
                  <div className="col-span-1">Price</div>
                  <div className="col-span-1 text-right">Action</div>
                </div>
                {fieldOptions.filter(o => o.field_id === selectedField.id).map(o => (
                  <div key={o.id} className="grid grid-cols-4 items-center px-4 py-3 bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                    <div className="text-sm font-medium text-zinc-900 dark:text-white">{o.value_en}</div>
                    <div className="text-sm text-zinc-500 dark:text-zinc-400">{o.value_ar}</div>
                    <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{o.price} KD</div>
                    <div className="text-right">
                      <button 
                        onClick={() => handleDeleteOption(o.id)}
                        className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Modals */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4 overflow-y-auto">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="bg-white dark:bg-zinc-900 rounded-[2rem] w-full max-w-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-2xl"
          >
            <div className="p-8 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between bg-zinc-50/50 dark:bg-zinc-800/30">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-zinc-900 dark:bg-white flex items-center justify-center text-white dark:text-zinc-900 shadow-lg">
                  {modalType === 'user' ? <UserPlus size={24} /> : modalType === 'brand' ? <Globe size={24} /> : <Settings size={24} />}
                </div>
                <div>
                  <h3 className="text-xl font-black text-zinc-900 dark:text-white tracking-tight">
                    {editingUser ? (lang === 'ar' ? 'تعديل مستخدم' : 'Edit User') : 
                     editingField ? (lang === 'ar' ? 'تعديل حقل' : 'Edit Field') : 
                     (lang === 'ar' ? `إضافة ${modalType === 'user' ? 'مستخدم' : modalType === 'brand' ? 'براند' : 'حقل'} جديد` : `Add New ${modalType}`)}
                  </h3>
                  <p className="text-xs font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
                    {editingUser || editingField ? (lang === 'ar' ? 'تحديث البيانات الحالية' : 'Update existing information') : (lang === 'ar' ? 'أدخل التفاصيل أدناه' : 'Enter the details below')}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setIsModalOpen(false);
                  setEditingUser(null);
                  setEditingField(null);
                }}
                className="p-2 hover:bg-white dark:hover:bg-zinc-800 rounded-xl text-zinc-400 dark:text-zinc-500 transition-colors shadow-sm"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={
              modalType === 'user' ? handleSaveUser : 
              modalType === 'brand' ? handleCreateBrand : 
              handleSaveField
            } className="p-8 space-y-6">
              {modalType === 'user' && (
                <div className="space-y-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                      <UserIcon size={12} className="text-zinc-300" />
                      {lang === 'ar' ? 'اسم المستخدم' : 'Username'}
                    </label>
                    <div className="relative group">
                      <input 
                        required
                        placeholder={lang === 'ar' ? 'أدخل اسم المستخدم' : "Enter username"} 
                        className="w-full pl-12 pr-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold"
                        value={formData.username || ''}
                        onChange={e => setFormData({ ...formData, username: e.target.value })}
                      />
                      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors">
                        <UserIcon size={20} />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                      <Lock size={12} className="text-zinc-300" />
                      {lang === 'ar' ? 'كلمة المرور' : 'Password'}
                    </label>
                    <div className="relative group">
                      <input 
                        type="password" 
                        required={!editingUser}
                        placeholder={editingUser ? (lang === 'ar' ? "اتركه فارغاً للحفاظ على الحالي" : "Leave blank to keep current") : (lang === 'ar' ? "أدخل كلمة المرور" : "Enter password")} 
                        className="w-full pl-12 pr-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold"
                        onChange={e => setFormData({ ...formData, password: e.target.value })}
                      />
                      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors">
                        <Lock size={20} />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                      <Shield size={12} className="text-zinc-300" />
                      {lang === 'ar' ? 'الدور الوظيفي' : 'User Role'}
                    </label>
                    <div className="relative group">
                      <select 
                        required
                        className="w-full pl-12 pr-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold appearance-none"
                        value={formData.role_id || ''}
                        onChange={e => setFormData({ ...formData, role_id: parseInt(e.target.value) })}
                      >
                        <option value="">{lang === 'ar' ? 'اختر الدور' : 'Select Role'}</option>
                        {roles.map(role => (
                          <option key={role.id} value={role.id}>{role.name}</option>
                        ))}
                      </select>
                      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors">
                        <Shield size={20} />
                      </div>
                    </div>
                  </div>

                  {/* Show Brand selection for Area Manager, Restaurants, Call Center, or Marketing Team role */}
                  {roles.find(r => r.id === formData.role_id)?.name === 'Area Manager' ? (
                    <div className="space-y-5 animate-in fade-in slide-in-from-top-2 duration-300">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                          <Building2 size={12} className="text-zinc-300" />
                          {lang === 'ar' ? 'البراند' : 'Brand'}
                        </label>
                        <div className="relative group">
                          <select 
                            className="w-full pl-12 pr-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold appearance-none"
                            value={formData.brand_id || ''}
                            onChange={e => setFormData({ ...formData, brand_id: parseInt(e.target.value), branch_ids: [] })}
                            required
                          >
                            <option value="">{lang === 'ar' ? 'اختر البراند' : 'Select Brand'}</option>
                            {brands.map(brand => (
                              <option key={brand.id} value={brand.id}>{brand.name}</option>
                            ))}
                          </select>
                          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors">
                            <Building2 size={20} />
                          </div>
                        </div>
                      </div>

                      {formData.brand_id && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                          <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                            <MapPin size={12} className="text-zinc-300" />
                            {lang === 'ar' ? 'الفروع المعينة' : 'Assigned Branches'}
                          </label>
                          <div className="grid grid-cols-2 gap-3 max-h-48 overflow-y-auto p-4 border border-zinc-200 dark:border-zinc-700 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-600">
                            {branches.filter(b => b.brand_id === formData.brand_id).map(branch => (
                              <label key={branch.id} className="flex items-center gap-3 p-3 bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 rounded-xl cursor-pointer transition-all hover:shadow-md hover:border-zinc-900 dark:hover:border-white group">
                                <div className="relative flex items-center justify-center">
                                  <input 
                                    type="checkbox"
                                    checked={(formData.branch_ids || []).includes(branch.id)}
                                    onChange={e => {
                                      const currentIds = formData.branch_ids || [];
                                      if (e.target.checked) {
                                        setFormData({ ...formData, branch_ids: [...currentIds, branch.id] });
                                      } else {
                                        setFormData({ ...formData, branch_ids: currentIds.filter((id: number) => id !== branch.id) });
                                      }
                                    }}
                                    className="w-5 h-5 rounded-lg border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-white focus:ring-zinc-900 dark:focus:ring-white transition-all"
                                  />
                                </div>
                                <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300 group-hover:text-zinc-900 dark:group-hover:text-white transition-colors">{branch.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : roles.find(r => r.id === formData.role_id)?.name === 'Restaurants' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                          <Building2 size={12} className="text-zinc-300" />
                          {lang === 'ar' ? 'البراند' : 'Brand'}
                        </label>
                        <div className="relative group">
                          <select 
                            className="w-full pl-12 pr-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold appearance-none"
                            value={formData.brand_id || ''}
                            onChange={e => setFormData({ ...formData, brand_id: parseInt(e.target.value), branch_id: undefined })}
                            required
                          >
                            <option value="">{lang === 'ar' ? 'اختر البراند' : 'Select Brand'}</option>
                            {brands.map(brand => (
                              <option key={brand.id} value={brand.id}>{brand.name}</option>
                            ))}
                          </select>
                          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors">
                            <Building2 size={20} />
                          </div>
                        </div>
                      </div>

                      {formData.brand_id && (
                        <div className="space-y-2 animate-in fade-in slide-in-from-left-2 duration-300">
                          <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                            <MapPin size={12} className="text-zinc-300" />
                            {lang === 'ar' ? 'الفرع' : 'Branch'}
                          </label>
                          <div className="relative group">
                            <select 
                              className="w-full pl-12 pr-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold appearance-none"
                              value={formData.branch_id || ''}
                              onChange={e => setFormData({ ...formData, branch_id: parseInt(e.target.value) })}
                              required
                            >
                              <option value="">{lang === 'ar' ? 'اختر الفرع' : 'Select Branch'}</option>
                              {branches.filter(b => b.brand_id === formData.brand_id).map(branch => (
                                <option key={branch.id} value={branch.id}>{branch.name}</option>
                              ))}
                            </select>
                            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-zinc-900 dark:group-focus-within:text-white transition-colors">
                              <MapPin size={20} />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (roles.find(r => r.id === formData.role_id)?.name === 'Call Center' ||
                       roles.find(r => r.id === formData.role_id)?.name === 'Marketing Team' ||
                       roles.find(r => r.id === formData.role_id)?.name === 'Operation Manager') && (
                    <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
                      <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1 flex items-center gap-2">
                        <Briefcase size={12} className="text-zinc-300" />
                        {lang === 'ar' ? 'البراندات المعينة' : 'Assigned Brands'}
                      </label>
                      <div className="grid grid-cols-2 gap-3 max-h-48 overflow-y-auto p-4 border border-zinc-200 dark:border-zinc-700 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-600">
                        {Array.isArray(brands) && brands.map(brand => (
                          <label key={brand.id} className="flex items-center gap-3 p-3 bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 rounded-xl cursor-pointer transition-all hover:shadow-md hover:border-zinc-900 dark:hover:border-white group">
                            <div className="relative flex items-center justify-center">
                              <input 
                                type="checkbox"
                                checked={(formData.brand_ids || []).includes(brand.id)}
                                onChange={e => {
                                  const currentIds = formData.brand_ids || [];
                                  if (e.target.checked) {
                                    setFormData({ ...formData, brand_ids: [...currentIds, brand.id] });
                                  } else {
                                    setFormData({ ...formData, brand_ids: currentIds.filter((id: number) => id !== brand.id) });
                                  }
                                }}
                                className="w-5 h-5 rounded-lg border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-white focus:ring-zinc-900 dark:focus:ring-white transition-all"
                              />
                            </div>
                            <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300 group-hover:text-zinc-900 dark:group-hover:text-white transition-colors">{brand.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {modalType === 'brand' && (
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">
                    {lang === 'ar' ? 'اسم البراند' : 'Brand Name'}
                  </label>
                  <input 
                    required
                    placeholder={lang === 'ar' ? "أدخل اسم البراند" : "Enter brand name"} 
                    className="w-full px-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold"
                    value={formData.name || ''}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                  />
                </div>
              )}

              {modalType === 'field' && (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">
                        {lang === 'ar' ? 'الاسم (EN)' : 'Name (EN)'}
                      </label>
                      <input 
                        required
                        placeholder="e.g. Size" 
                        className="w-full px-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold"
                        value={formData.name_en || ''}
                        onChange={e => setFormData({ ...formData, name_en: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">
                        {lang === 'ar' ? 'الاسم (AR)' : 'Name (AR)'}
                      </label>
                      <input 
                        required
                        placeholder="مثال: الحجم" 
                        className="w-full px-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold"
                        value={formData.name_ar || ''}
                        onChange={e => setFormData({ ...formData, name_ar: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest ml-1">
                      {lang === 'ar' ? 'نوع الحقل' : 'Field Type'}
                    </label>
                    <select 
                      className="w-full px-5 py-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-white outline-none focus:ring-8 focus:ring-zinc-900/5 dark:focus:ring-white/5 focus:border-zinc-900 dark:focus:border-white focus:bg-white dark:focus:bg-zinc-900 transition-all font-bold appearance-none"
                      value={formData.type || 'text'}
                      onChange={e => setFormData({ ...formData, type: e.target.value })}
                    >
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="dropdown">Dropdown</option>
                      <option value="multiselect">Multi Select</option>
                      <option value="checkbox">Checkbox</option>
                    </select>
                  </div>

                  <label className="flex items-center gap-3 p-4 bg-zinc-50 dark:bg-zinc-800/50 rounded-2xl border border-zinc-100 dark:border-zinc-800 cursor-pointer hover:bg-white dark:hover:bg-zinc-900 transition-all group">
                    <input 
                      type="checkbox" 
                      checked={formData.is_mandatory === 1}
                      onChange={e => setFormData({ ...formData, is_mandatory: e.target.checked ? 1 : 0 })}
                      className="w-5 h-5 rounded-lg border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-white focus:ring-zinc-900 dark:focus:ring-white"
                    />
                    <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300 group-hover:text-zinc-900 dark:group-hover:text-white transition-colors">
                      {lang === 'ar' ? 'حقل إلزامي' : 'Mandatory Field'}
                    </span>
                  </label>
                </div>
              )}

              <div className="flex gap-4 pt-4">
                <button 
                  type="button" 
                  onClick={() => {
                    setIsModalOpen(false);
                    setEditingUser(null);
                    setEditingField(null);
                  }} 
                  className="flex-1 py-4 rounded-2xl border border-zinc-200 dark:border-zinc-700 font-black text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all uppercase tracking-widest text-xs"
                >
                  {lang === 'ar' ? 'إلغاء' : 'Cancel'}
                </button>
                <button 
                  type="submit" 
                  className="flex-1 py-4 rounded-2xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 font-black shadow-xl shadow-zinc-900/20 dark:shadow-white/10 hover:bg-zinc-800 dark:hover:bg-zinc-100 transition-all uppercase tracking-widest text-xs"
                >
                  {editingUser || editingField ? (lang === 'ar' ? 'تحديث' : 'Update') : (lang === 'ar' ? 'إنشاء' : 'Create')}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}


