import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types';
import { API_URL, getUser, removeUser } from '../lib/utils';

interface AuthContextType {
  user: User | null;
  login: (user: User) => void;
  logout: () => void;
  lang: 'en' | 'ar';
  setLang: (lang: 'en' | 'ar') => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null>(getUser());
  const [lang, setLang] = useState<'en' | 'ar'>('en');

  // v2: JWT lives in an httpOnly cookie set by /api/login. We only keep user
  // metadata in localStorage for UI rehydration on reload. See S-13/S-14.
  const login = (user: User) => {
    localStorage.setItem('user', JSON.stringify(user));
    setUserState(user);
  };

  const logout = () => {
    // Best-effort: tell the server to clear the cookie. Don't await — the UI
    // can switch back to the login screen immediately.
    fetch(`${API_URL}/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
    removeUser();
    setUserState(null);
  };

  useEffect(() => {
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <AuthContext.Provider value={{ user, login, logout, lang, setLang }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
