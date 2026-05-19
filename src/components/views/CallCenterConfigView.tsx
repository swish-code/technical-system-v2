import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, Save, X, ChevronUp, ChevronDown, Settings, List, Type, Hash, AlignLeft, Code, Globe, Briefcase } from 'lucide-react';
import { CallCenterFormField, CallCenterFieldOption } from '../../types';
import { useFetch } from '../../hooks/useFetch';
import { API_URL, safeJson } from '../../lib/utils';

interface CallCenterConfigViewProps {
  onBack?: () => void;
}

interface ConfigData {
  fields: CallCenterFormField[];
  options: CallCenterFieldOption[];
  technicalTypes: any[];
  platforms: any[];
  caseTypes: any[];
  brands: any[];
}

const ConfigCard = ({ title, icon: Icon, items, onAdd, onDelete, type, placeholder, value, onChange }: any) => (
  <div className="bg-[#0f1117] border border-zinc-800 rounded-2xl p-6 shadow-2xl flex flex-col h-full">
    <div className="flex items-center gap-3 mb-6">
      <div className="w-10 h-10 rounded-xl bg-zinc-800/50 flex items-center justify-center text-zinc-400">
        <Icon size={20} />
      </div>
      <h2 className="text-xl font-black text-white tracking-tight">{title}</h2>
    </div>

    <div className="relative mb-6">
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onAdd()}
        className="w-full bg-[#161922] border border-zinc-800 rounded-xl px-4 py-3 text-white font-bold outline-none focus:border-blue-500 transition-all pr-12"
      />
      <button
        onClick={onAdd}
        className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center hover:bg-blue-500 transition-all"
      >
        <Plus size={18} />
      </button>
    </div>

    <div className="flex flex-wrap gap-2 overflow-y-auto max-h-48 custom-scrollbar">
      {items.map((item: any) => (
        <div key={item.id} className="flex items-center gap-2 bg-[#1c212c] border border-zinc-800 px-3 py-1.5 rounded-lg group transition-all hover:border-zinc-700">
          <span className="text-sm font-bold text-zinc-300">{item.name_en || item.value_en}</span>
          <button
            onClick={() => onDelete(item.id)}
            className="text-zinc-500 hover:text-red-500 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {items.length === 0 && (
        <p className="text-zinc-600 text-sm italic py-2">No items added yet.</p>
      )}
    </div>
  </div>
);

export const CallCenterConfigView: React.FC<CallCenterConfigViewProps> = () => {
  const { fetchWithAuth } = useFetch();
  const [data, setData] = useState<ConfigData>({
    fields: [],
    options: [],
    technicalTypes: [],
    platforms: [],
    caseTypes: [],
    brands: []
  });
  const [loading, setLoading] = useState(true);
  const [editingField, setEditingField] = useState<Partial<CallCenterFormField>>({ name_en: '', name_ar: '', type: 'text', is_required: false });
  const [newOption, setNewOption] = useState<{ fieldId: number; en: string; ar: string }>({ fieldId: 0, en: '', ar: '' });
  
  // New item states
  const [newItem, setNewItem] = useState({
    platform: { en: '', ar: '' },
    caseType: { en: '', ar: '' },
    technicalType: { en: '', ar: '' }
  });

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const response = await fetchWithAuth(`${API_URL}/call-center/config`);
      if (response.ok) {
        const result = await safeJson(response);
        if (result && typeof result === 'object') {
          setData({
            fields: Array.isArray(result.fields) ? result.fields : [],
            options: Array.isArray(result.options) ? result.options : [],
            technicalTypes: Array.isArray(result.technicalTypes) ? result.technicalTypes : [],
            platforms: Array.isArray(result.platforms) ? result.platforms : [],
            caseTypes: Array.isArray(result.caseTypes) ? result.caseTypes : [],
            brands: Array.isArray(result.brands) ? result.brands : []
          });
        }
      }
    } catch (error) {
      console.error('Failed to fetch config:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddItem = async (type: 'platforms' | 'case-types' | 'technical-types', value: { en: string; ar: string }) => {
    if (!value.en) return;
    try {
      const response = await fetchWithAuth(`${API_URL}/call-center/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name_en: value.en, name_ar: value.ar || value.en }),
      });
      if (response.ok) {
        setNewItem(prev => ({ ...prev, [type.replace(/-([a-z])/g, (g) => g[1].toUpperCase()).replace(/s$/, '')]: { en: '', ar: '' } }));
        fetchConfig();
      }
    } catch (error) {
      console.error(`Failed to add ${type}:`, error);
    }
  };

  const handleDeleteItem = async (type: 'platforms' | 'case-types' | 'technical-types', id: number) => {
    try {
      const response = await fetchWithAuth(`${API_URL}/call-center/${type}/${id}`, { method: 'DELETE' });
      if (response.ok) fetchConfig();
    } catch (error) {
      console.error(`Failed to delete ${type}:`, error);
    }
  };

  const handleSaveField = async () => {
    if (!editingField.name_en) return;
    const method = editingField.id ? 'PUT' : 'POST';
    const url = editingField.id ? `${API_URL}/call-center/fields/${editingField.id}` : `${API_URL}/call-center/fields`;

    try {
      const response = await fetchWithAuth(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editingField, display_order: data.fields.length }),
      });

      if (response.ok) {
        setEditingField({ name_en: '', name_ar: '', type: 'text', is_required: false });
        fetchConfig();
      }
    } catch (error) {
      console.error('Failed to save field:', error);
    }
  };

  const handleDeleteField = async (id: number) => {
    try {
      const response = await fetchWithAuth(`${API_URL}/call-center/fields/${id}`, { method: 'DELETE' });
      if (response.ok) fetchConfig();
    } catch (error) {
      console.error('Failed to delete field:', error);
    }
  };

  const handleAddOption = async (fieldId: number) => {
    if (!newOption.en) return;
    try {
      const response = await fetchWithAuth(`${API_URL}/call-center/fields/${fieldId}/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value_en: newOption.en,
          value_ar: newOption.ar || newOption.en,
          display_order: data.options.filter(o => o.field_id === fieldId).length,
        }),
      });
      if (response.ok) {
        setNewOption({ fieldId: 0, en: '', ar: '' });
        fetchConfig();
      }
    } catch (error) {
      console.error('Failed to add option:', error);
    }
  };

  if (loading) return <div className="p-8 text-center text-zinc-500 font-bold">Loading Configuration...</div>;

  return (
    <div className="min-h-screen bg-[#090a0f] text-white p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-center justify-between mb-12">
          <div>
            <h1 className="text-4xl font-black tracking-tighter mb-2">Call Center Configuration</h1>
            <p className="text-zinc-500 font-medium">Manage all dynamic data for call center cases and requests.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <ConfigCard
            title="Platforms"
            icon={Globe}
            items={data.platforms}
            onAdd={() => handleAddItem('platforms', newItem.platform)}
            onDelete={(id: number) => handleDeleteItem('platforms', id)}
            placeholder="New Platform"
            value={newItem.platform.en}
            onChange={(val: string) => setNewItem({ ...newItem, platform: { ...newItem.platform, en: val } })}
          />

          <ConfigCard
            title="Titles & Cases"
            icon={Briefcase}
            items={data.caseTypes}
            onAdd={() => handleAddItem('case-types', newItem.caseType)}
            onDelete={(id: number) => handleDeleteItem('case-types', id)}
            placeholder="New Title"
            value={newItem.caseType.en}
            onChange={(val: string) => setNewItem({ ...newItem, caseType: { ...newItem.caseType, en: val } })}
          />

          <ConfigCard
            title="Technical Types"
            icon={Code}
            items={data.technicalTypes}
            onAdd={() => handleAddItem('technical-types', newItem.technicalType)}
            onDelete={(id: number) => handleDeleteItem('technical-types', id)}
            placeholder="New Technical Type"
            value={newItem.technicalType.en}
            onChange={(val: string) => setNewItem({ ...newItem, technicalType: { ...newItem.technicalType, en: val } })}
          />
        </div>

        {/* Custom Input Fields Section */}
        <div className="bg-[#0f1117] border border-zinc-800 rounded-[2rem] p-8 shadow-2xl mt-12">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-500">
              <Settings size={24} />
            </div>
            <h2 className="text-2xl font-black tracking-tight">Custom Input Fields</h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-black text-zinc-500 uppercase tracking-widest ml-1">Field Name</label>
                <input
                  type="text"
                  placeholder="e.g. Serial Number"
                  value={editingField.name_en}
                  onChange={(e) => setEditingField({ ...editingField, name_en: e.target.value })}
                  className="w-full bg-[#161922] border border-zinc-800 rounded-2xl px-6 py-4 text-white font-bold outline-none focus:border-blue-500 transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-black text-zinc-500 uppercase tracking-widest ml-1">Field Type</label>
                <div className="grid grid-cols-2 gap-4">
                  <button
                    onClick={() => setEditingField({ ...editingField, type: 'text' })}
                    className={`py-4 rounded-2xl font-black transition-all border ${
                      editingField.type === 'text' 
                        ? 'bg-blue-600 border-blue-600 text-white' 
                        : 'bg-[#161922] border-zinc-800 text-zinc-400 hover:border-zinc-700'
                    }`}
                  >
                    Text Input
                  </button>
                  <button
                    onClick={() => setEditingField({ ...editingField, type: 'selection' })}
                    className={`py-4 rounded-2xl font-black transition-all border ${
                      editingField.type === 'selection' 
                        ? 'bg-blue-600 border-blue-600 text-white' 
                        : 'bg-[#161922] border-zinc-800 text-zinc-400 hover:border-zinc-700'
                    }`}
                  >
                    Dropdown Selection
                  </button>
                </div>
              </div>

              <button
                onClick={handleSaveField}
                className="w-full py-5 bg-blue-600 text-white rounded-2xl font-black text-lg hover:bg-blue-500 transition-all shadow-xl shadow-blue-600/20 flex items-center justify-center gap-3"
              >
                <Plus size={24} />
                Add Custom Field
              </button>
            </div>

            <div className="space-y-6">
              <label className="text-xs font-black text-zinc-500 uppercase tracking-widest ml-1">Existing Custom Fields</label>
              <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {data.fields.map((field) => (
                  <div key={field.id} className="bg-[#161922] border border-zinc-800 rounded-2xl p-6 group transition-all hover:border-zinc-700">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl bg-zinc-800 flex items-center justify-center text-zinc-400">
                          {field.type === 'text' ? <AlignLeft size={20} /> : <List size={20} />}
                        </div>
                        <div>
                          <h3 className="font-bold text-white">{field.name_en}</h3>
                          <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">{field.type}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteField(field.id)}
                        className="p-2 text-zinc-600 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>

                    {field.type === 'selection' && (
                      <div className="space-y-4 mt-4 pt-4 border-t border-zinc-800/50">
                        <div className="flex flex-wrap gap-2">
                          {data.options.filter(o => o.field_id === field.id).map(opt => (
                            <div key={opt.id} className="bg-[#1c212c] px-3 py-1 rounded-lg text-xs font-bold text-zinc-400 border border-zinc-800 flex items-center gap-2">
                              {opt.value_en}
                              <button onClick={() => {}} className="hover:text-red-500"><X size={12} /></button>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="Add Option"
                            value={newOption.fieldId === field.id ? newOption.en : ''}
                            onChange={(e) => setNewOption({ fieldId: field.id, en: e.target.value, ar: '' })}
                            className="flex-1 bg-[#090a0f] border border-zinc-800 rounded-xl px-4 py-2 text-sm font-bold outline-none focus:border-blue-500"
                          />
                          <button
                            onClick={() => handleAddOption(field.id)}
                            className="bg-zinc-800 hover:bg-zinc-700 px-4 py-2 rounded-xl text-sm font-bold transition-all"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {data.fields.length === 0 && (
                  <div className="text-center py-12 bg-[#161922] border border-dashed border-zinc-800 rounded-2xl">
                    <p className="text-zinc-600 font-bold italic">No custom fields created yet.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #1c212c;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #2d3446;
        }
      `}</style>
    </div>
  );
};

export default CallCenterConfigView;
