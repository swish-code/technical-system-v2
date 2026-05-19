import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { API_URL } from '../lib/utils';
import { User, Lock, Loader2, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';

export default function Login() {
  const { login, lang, setLang } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      
      let data;
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        data = await res.json();
      } else {
        const text = await res.text();
        console.error("Non-JSON response:", text);
        throw new Error("Invalid server response");
      }

      if (res.ok) {
        login(data.user, data.token);
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err: any) {
      console.error("Login error:", err);
      if (err.message?.includes('getaddrinfo') || err.message?.includes('EAI_AGAIN')) {
        setError('Database connection error. Please use the PUBLIC connection string from Railway.');
      } else {
        setError('Connection error. Please check your network or server status.');
      }
    } finally {
      setLoading(false);
    }
  };

  const t = {
    en: {
      systemTitle: "Swish Menu Management System",
      description: "A professional platform designed for efficient handling and tracking of menu items, brands, and product configurations.",
      loginTitle: "Swish Menu System",
      loginSubtitle: "Enter your credentials to access your account",
      username: "USERNAME",
      password: "PASSWORD",
      usernamePlaceholder: "Enter your username",
      passwordPlaceholder: "Enter your password",
      signIn: "Sign In to Dashboard",
      loading: "Signing in...",
      footer: "© 2026 Swish Menu Management System. All rights reserved."
    },
    ar: {
      systemTitle: "نظام إدارة سويش مينيو",
      description: "منصة احترافية مصممة للتعامل الفعال وتتبع عناصر القائمة والعلامات التجارية وتكوينات المنتجات.",
      loginTitle: "نظام سويش مينيو",
      loginSubtitle: "أدخل بيانات الاعتماد الخاصة بك للوصول إلى حسابك",
      username: "اسم المستخدم",
      password: "كلمة المرور",
      usernamePlaceholder: "أدخل اسم المستخدم",
      passwordPlaceholder: "أدخل كلمة المرور",
      signIn: "تسجيل الدخول إلى لوحة التحكم",
      loading: "جاري الدخول...",
      footer: "© 2026 نظام إدارة سويش مينيو. جميع الحقوق محفوظة."
    }
  }[lang];

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
      {/* Left Side - Branding & Atmosphere */}
      <div className="hidden md:flex md:w-1/2 relative overflow-hidden bg-zinc-900">
        {/* Animated Background Elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <motion.div 
            animate={{ 
              scale: [1, 1.2, 1],
              rotate: [0, 90, 0],
              opacity: [0.3, 0.5, 0.3]
            }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
            className="absolute -top-1/2 -left-1/2 w-full h-full bg-brand/20 blur-[120px] rounded-full" 
          />
          <motion.div 
            animate={{ 
              scale: [1.2, 1, 1.2],
              rotate: [0, -90, 0],
              opacity: [0.2, 0.4, 0.2]
            }}
            transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
            className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-brand-light/10 blur-[100px] rounded-full" 
          />
        </div>

        <div className="relative z-10 p-16 lg:p-24 flex flex-col justify-between h-full text-white">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className="mb-16">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-brand rounded-2xl flex items-center justify-center shadow-lg shadow-brand/20">
                  <span className="text-white font-black text-2xl tracking-tighter">S</span>
                </div>
                <span className="text-2xl font-display font-bold tracking-tight">Swish Menu</span>
              </div>
            </div>
            
            <h1 className="text-6xl lg:text-8xl font-display font-black leading-[0.9] mb-8 tracking-tighter uppercase">
              TECHNICAL <br />
              <span className="text-brand">SYSTEM</span>
            </h1>
            <p className="text-xl text-zinc-400 max-w-md leading-relaxed font-light">
              {t.description}
            </p>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 1 }}
            className="flex items-center gap-8 text-zinc-500 text-sm font-medium tracking-widest uppercase"
          >
            <span>EST. 2026</span>
            <div className="w-12 h-[1px] bg-zinc-800" />
            <span>PROFESSIONAL GRADE</span>
          </motion.div>
        </div>
      </div>

      {/* Right Side - Login Form */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 lg:p-24 relative">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="w-full max-w-md"
        >
          <div className="mb-12">
            <h2 className="text-4xl font-display font-black text-zinc-900 dark:text-white mb-3 tracking-tight">
              {t.loginTitle}
            </h2>
            <p className="text-zinc-500 dark:text-zinc-400 font-medium text-lg">
              {t.loginSubtitle}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-zinc-400 dark:text-zinc-500 tracking-widest uppercase ml-1">
                {t.username}
              </label>
              <div className="relative group">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors">
                  <User size={20} />
                </div>
                <input
                  type="text"
                  required
                  placeholder={t.usernamePlaceholder}
                  className="w-full pl-12 pr-4 py-4 rounded-2xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-medium text-zinc-900 dark:text-white shadow-sm"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold text-zinc-400 dark:text-zinc-500 tracking-widest uppercase ml-1">
                {t.password}
              </label>
              <div className="relative group">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-brand transition-colors">
                  <Lock size={20} />
                </div>
                <input
                  type="password"
                  required
                  placeholder={t.passwordPlaceholder}
                  className="w-full pl-12 pr-4 py-4 rounded-2xl bg-white dark:bg-zinc-900 border-2 border-zinc-100 dark:border-zinc-800 focus:border-brand outline-none transition-all font-medium text-zinc-900 dark:text-white shadow-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="p-4 rounded-2xl bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm font-bold border border-red-100 dark:border-red-900/50 flex items-center gap-3"
              >
                <div className="w-2 h-2 rounded-full bg-red-600 dark:bg-red-400 animate-pulse" />
                {error}
              </motion.div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-brand text-white py-5 rounded-2xl font-black text-lg shadow-xl shadow-brand/20 hover:bg-brand-dark transition-all active:scale-[0.98] flex items-center justify-center gap-3 disabled:opacity-70 group"
            >
              {loading ? (
                <Loader2 className="w-6 h-6 animate-spin" />
              ) : (
                <>
                  {t.signIn}
                  <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>

          <div className="mt-16 pt-8 border-t border-zinc-100 dark:border-zinc-800 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs font-bold text-zinc-400 dark:text-zinc-600 uppercase tracking-widest">
              {t.footer}
            </p>
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
                className="text-xs font-black text-brand uppercase tracking-widest hover:text-brand-dark transition-colors"
              >
                {lang === 'en' ? 'العربية' : 'English'}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
