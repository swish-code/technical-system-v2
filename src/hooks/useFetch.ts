import { useAuth } from '../context/AuthContext';

export function useFetch() {
  const { logout } = useAuth();

  // v2: auth is via httpOnly cookie. `credentials: 'include'` tells the browser
  // to attach the cookie on same-origin requests. No Authorization header. See S-13/S-14.
  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const response = await fetch(url, { ...options, credentials: 'include' });

    if (response.status === 401) {
      logout();
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
