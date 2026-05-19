import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import Login from './components/Login';
import Dashboard from './components/Dashboard';

function AppContent() {
  try {
    const { user } = useAuth();
    return user ? <Dashboard /> : <Login />;
  } catch (error) {
    console.error("Error in AppContent:", error);
    return (
      <div className="p-10 bg-red-500 text-white">
        <h1>Critical Error in Application</h1>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
      </div>
    );
  }
}

export default function App() {
  return (
    <div id="app-root-container">
      <ThemeProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </ThemeProvider>
    </div>
  );
}
