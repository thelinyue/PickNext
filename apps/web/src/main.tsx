import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.js';
import { isNetworkError } from './api.js';
import './styles.css';

const client = new QueryClient({ defaultOptions: {
  queries: {
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, reason) => failureCount < 1 && isNetworkError(reason)
  },
  mutations: { retry: false }
} });
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><App /></QueryClientProvider></StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
