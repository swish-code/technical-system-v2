import { useAuth } from '../context/AuthContext';
import { API_URL } from '../lib/utils';

export function useFetch() {
  const { logout } = useAuth();

  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const token = localStorage.getItem('token');
    const headers = {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    };

    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
      logout();
      // Throw a specific error that can be identified by callers
      const authError = new Error('Unauthorized');
      (authError as any).isAuthError = true;
      throw authError;
    }

    return response;
  };

  const fetchJson = async (url: string, options: RequestInit = {}) => {
    const response = await fetchWithAuth(url, options);
    if (!response.ok) return null;
    return response.json();
  };

  return { fetchWithAuth, fetchJson };
}
