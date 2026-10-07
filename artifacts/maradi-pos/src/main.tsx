import { createRoot } from 'react-dom/client';
import { setBaseUrl } from '@workspace/api-client-react';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

// Бэкенд на другом домене (Render Web Service) задаётся через VITE_API_URL
// при сборке; без переменной запросы идут относительно текущего хоста
// (в режиме «один сервис отдаёт и API, и интерфейс»).
const apiBaseUrl = import.meta.env.VITE_API_URL;
if (typeof apiBaseUrl === 'string' && apiBaseUrl.trim() !== '') {
  setBaseUrl(apiBaseUrl.trim());
}

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
