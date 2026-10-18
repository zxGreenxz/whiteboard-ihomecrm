import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import BankReconciliationDemo from './BankReconciliationDemo';

const root = document.getElementById('root');
if (root) createRoot(root).render(<React.StrictMode><BankReconciliationDemo /></React.StrictMode>);
