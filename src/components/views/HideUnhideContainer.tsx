import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { EyeOff, RefreshCw, History, Bell, BellOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn, API_URL } from '../../lib/utils';
import { useFetch } from '../../hooks/useFetch';
import HideItemView from './HideItemView';
import UnhideItemView from './UnhideItemView';
import HistoryView from './HistoryView';
import PendingRequestsView from './PendingRequestsView';
import { Inbox } from 'lucide-react';

export default function HideUnhideContainer() {
  const { user, lang } = useAuth();
  const [activeTab, setActiveTab] = useState<'hide' | 'unhide' | 'history'>(
    user?.role_name === 'Call Center' || user?.role_name === 'Complain Team' ? 'unhide' : 'hide'
  );

  // Restaurant-owned switch for the hourly "still hidden" alert posted into its chat.
  const { fetchWithAuth } = useFetch();
  const isRestaurant = user?.role_name === 'Restaurants';
  const [hiddenHourly, setHiddenHourly] = useState(true);
  useEffect(() => {
    if (!isRestaurant) return;
    (async () => {
      try { const r = await fetchWithAuth(`${API_URL}/branch-notify-settings`); if (r.ok) { const d = await r.json(); setHiddenHourly(!!d.hidden_hourly); } } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestaurant]);
  const toggleHiddenHourly = async () => {
    const next = !hiddenHourly;
    setHiddenHourly(next); // optimistic; revert if the write fails
    try {
      const r = await fetchWithAuth(`${API_URL}/branch-notify-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden_hourly: next }) });
      if (!r.ok) setHiddenHourly(!next);
    } catch { setHiddenHourly(!next); }
  };

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
    { id: 'unhide', label: t.unhide, icon: RefreshCw, roles: ["Technical Back Office", "Manager", "Call Center", "Complain Team", "Super Visor", "Restaurants", "Area Manager"] },
    { id: 'history', label: t.history, icon: History, roles: ["Technical Back Office", "Manager", "Call Center", "Complain Team", "Super Visor", "Restaurants", "Area Manager"] },
  ].filter(tab => tab.roles.includes(user?.role_name || ''));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3 flex-wrap">
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
      {isRestaurant && (
        <button onClick={toggleHiddenHourly}
          title={lang === 'ar' ? 'تنبيه يُرسل إلى محادثة فرعك عند بقاء أصناف مخفية أكثر من ساعة' : 'Alert posted to your branch chat when items stay hidden for over an hour'}
          className={cn("inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest border-2 transition active:scale-95 whitespace-nowrap",
            hiddenHourly ? "bg-brand/10 text-brand border-brand/20" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 border-transparent")}>
          {hiddenHourly ? <Bell size={16} /> : <BellOff size={16} />}
          {lang === 'ar' ? 'تنبيه المخفي كل ساعة' : 'Hourly hidden alert'}
        </button>
      )}
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
