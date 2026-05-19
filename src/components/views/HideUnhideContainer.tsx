import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { EyeOff, RefreshCw, History } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';
import HideItemView from './HideItemView';
import UnhideItemView from './UnhideItemView';
import HistoryView from './HistoryView';
import PendingRequestsView from './PendingRequestsView';
import { Inbox } from 'lucide-react';

export default function HideUnhideContainer() {
  const { user, lang } = useAuth();
  const [activeTab, setActiveTab] = useState<'hide' | 'unhide' | 'history'>(
    user?.role_name === 'Call Center' ? 'unhide' : 'hide'
  );

  const t = {
    en: {
      hide: "Hide",
      unhide: "Unhide",
      history: "History"
    },
    ar: {
      hide: "إخفاء",
      unhide: "إظهار",
      history: "السجل"
    }
  }[lang];

  const tabs = [
    { id: 'hide', label: t.hide, icon: EyeOff, roles: ["Technical Back Office", "Manager", "Super Visor", "Restaurants", "Area Manager"] },
    { id: 'unhide', label: t.unhide, icon: RefreshCw, roles: ["Technical Back Office", "Manager", "Call Center", "Super Visor", "Restaurants", "Area Manager"] },
    { id: 'history', label: t.history, icon: History, roles: ["Technical Back Office", "Manager", "Call Center", "Super Visor", "Restaurants", "Area Manager"] },
  ].filter(tab => tab.roles.includes(user?.role_name || ''));

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 bg-white dark:bg-zinc-900 p-1.5 rounded-2xl border border-zinc-200 dark:border-zinc-800 w-full sm:w-fit shadow-sm overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-2 min-w-max">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={cn(
                "flex items-center gap-2 px-6 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest transition-all whitespace-nowrap",
                activeTab === tab.id
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 shadow-lg"
                  : "text-zinc-500 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-50 dark:hover:bg-zinc-800"
              )}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'hide' && <HideItemView />}
          {activeTab === 'unhide' && <UnhideItemView />}
          {activeTab === 'history' && <HistoryView />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
