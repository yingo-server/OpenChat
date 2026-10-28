import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
