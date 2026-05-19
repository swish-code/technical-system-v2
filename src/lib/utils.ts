import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const API_URL = "/api";

export const getAuthToken = () => localStorage.getItem("token");
export const setAuthToken = (token: string) => localStorage.setItem("token", token);
export const removeAuthToken = () => localStorage.removeItem("token");

export const getUser = () => {
  try {
    const user = localStorage.getItem("user");
    return user ? JSON.parse(user) : null;
  } catch (e) {
    console.warn("Failed to parse user from localStorage:", e);
    localStorage.removeItem("user");
    return null;
  }
};
export const setUser = (user: any) => localStorage.setItem("user", JSON.stringify(user));
export const removeUser = () => localStorage.removeItem("user");

export function formatDate(dateStr: string, options: Intl.DateTimeFormatOptions = {}) {
  if (!dateStr) return "";
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric', 
    month: 'numeric', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kuwait'
  };

  const mergedOptions = { ...defaultOptions, ...options };

  let date: Date;
  if (dateStr.includes('T') || dateStr.includes('Z')) {
    date = new Date(dateStr);
  } else {
    // Handle SQLite format YYYY-MM-DD HH:MM:SS by assuming it's UTC
    date = new Date(dateStr.replace(' ', 'T') + 'Z');
  }
  
  try {
    return new Intl.DateTimeFormat('en-US', mergedOptions).format(date);
  } catch (e) {
    return date.toLocaleString('en-US', { ...mergedOptions, timeZone: 'Asia/Kuwait' });
  }
}

/**
 * Safely parse JSON from a response, returning null if parsing fails or if the body is empty.
 * This prevents "JSON.parse: unexpected character" errors when the API returns HTML or empty responses.
 */
export async function safeJson(response: Response) {
  try {
    const text = await response.text();
    if (!text || text.trim() === "") return null;
    return JSON.parse(text);
  } catch (e) {
    console.warn(`[safeJson] Failed to parse response from ${response.url}. Response status: ${response.status}`);
    return null;
  }
}
