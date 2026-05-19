import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '../lib/utils';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  lang?: 'en' | 'ar';
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  lang = 'en'
}: ConfirmModalProps) {
  if (!isOpen) return null;

  const isAr = lang === 'ar';

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className={cn(
            "bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl border border-zinc-200 dark:border-zinc-800 w-full max-w-md overflow-hidden",
            isAr ? "text-right" : "text-left"
          )}
        >
          <div className="p-6">
            <div className={cn("flex items-start gap-4", isAr ? "flex-row-reverse" : "flex-row")}>
              <div className={cn(
                "shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center",
                variant === 'danger' ? "bg-red-50 dark:bg-red-900/20 text-red-600" : 
                variant === 'warning' ? "bg-amber-50 dark:bg-amber-900/20 text-amber-600" :
                "bg-blue-50 dark:bg-blue-900/20 text-blue-600"
              )}>
                <AlertTriangle size={24} />
              </div>
              <div className="flex-1">
                <h3 className="text-xl font-black text-zinc-900 dark:text-white tracking-tight mb-2">
                  {title}
                </h3>
                <p className="text-zinc-500 dark:text-zinc-400 font-medium text-sm leading-relaxed">
                  {message}
                </p>
              </div>
              <button 
                onClick={onCancel}
                className="p-2 text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          <div className={cn(
            "p-6 bg-zinc-50 dark:bg-zinc-950 flex gap-3",
            isAr ? "flex-row-reverse" : "flex-row"
          )}>
            <button
              onClick={onConfirm}
              className={cn(
                "flex-1 py-3 px-4 rounded-xl text-sm font-bold transition-all shadow-sm",
                variant === 'danger' ? "bg-red-600 hover:bg-red-700 text-white shadow-red-200 dark:shadow-none" :
                variant === 'warning' ? "bg-amber-600 hover:bg-amber-700 text-white shadow-amber-200 dark:shadow-none" :
                "bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200 dark:shadow-none"
              )}
            >
              {confirmText}
            </button>
            <button
              onClick={onCancel}
              className="flex-1 py-3 px-4 rounded-xl text-sm font-bold bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all"
            >
              {cancelText}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
