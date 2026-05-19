import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Bell, X, Info, AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../hooks/useWebSocket';
import { AppNotification } from '../types';
import { cn } from '../lib/utils';

export default function NotificationManager() {
  const { user, lang } = useAuth();
  const lastMessage = useWebSocket();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const playSound = useCallback(() => {
    try {
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
      audio.volume = 0.5;
      audio.play();
    } catch (e) {
      console.warn('Audio playback failed:', e);
    }
  }, []);

  useEffect(() => {
    if (lastMessage?.type === 'NOTIFICATION') {
      const notificationData = lastMessage;
      
      const isSystemAction = notificationData.notificationType === 'SYSTEM_ACTION';
      
      // Filter based on relevance to the current user
      const isRelevant = isSystemAction || !notificationData.role_target || 
        notificationData.role_target.includes(user?.role_name || '');
      
      const brandMatch = isSystemAction || !notificationData.brand_id || 
        user?.brand_id === notificationData.brand_id || 
        user?.brand_ids?.includes(notificationData.brand_id);
        
      const branchMatch = isSystemAction || !notificationData.branch_id || 
        user?.branch_id === notificationData.branch_id || 
        user?.branch_ids?.includes(notificationData.branch_id);

      const userMatch = !notificationData.user_id || 
        user?.id === notificationData.user_id;

      if (isRelevant && brandMatch && branchMatch && userMatch) {
        const newNotification: AppNotification = {
          id: Math.random().toString(36).substr(2, 9),
          ...notificationData,
          timestamp: new Date().toISOString()
        };
        
        setNotifications(prev => [newNotification, ...prev].slice(0, 5));
        playSound();
        
        // Auto-remove after 8 seconds
        setTimeout(() => {
          setNotifications(prev => prev.filter(n => n.id !== newNotification.id));
        }, 8000);
      }
    }
  }, [lastMessage, user, playSound]);

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'BUSY_BRANCH': return <AlertTriangle className="text-amber-500" size={20} />;
      case 'HIDDEN_ITEM': return <Info className="text-blue-500" size={20} />;
      case 'CALL_CENTER': return <Clock className="text-brand" size={20} />;
      case 'NEW_REQUEST': return <CheckCircle className="text-emerald-500" size={20} />;
      default: return <Bell className="text-brand" size={20} />;
    }
  };

  return (
    <div className="fixed top-6 right-6 z-[100] flex flex-col gap-4 w-full max-w-sm pointer-events-none">
      <AnimatePresence>
        {notifications.map((notification) => (
          <motion.div
            key={notification.id}
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
            className={cn(
              "pointer-events-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 p-4 flex gap-4 relative overflow-hidden group",
              lang === 'ar' ? "flex-row-reverse text-right" : "flex-row text-left"
            )}
          >
            {/* Progress Bar */}
            <motion.div 
              initial={{ width: "100%" }}
              animate={{ width: "0%" }}
              transition={{ duration: 8, ease: "linear" }}
              className="absolute bottom-0 left-0 h-1 bg-brand/30"
            />

            <div className="shrink-0 w-12 h-12 rounded-xl bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center">
              {getIcon(notification.notificationType)}
            </div>

            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-black text-zinc-900 dark:text-white tracking-tight mb-0.5">
                {lang === 'en' ? notification.title_en : notification.title_ar}
              </h4>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium leading-relaxed">
                {lang === 'en' ? notification.message_en : notification.message_ar}
              </p>
            </div>

            <button
              onClick={() => removeNotification(notification.id)}
              className="shrink-0 p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
            >
              <X size={16} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
