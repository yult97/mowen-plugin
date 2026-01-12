import React from 'react';
import ReactDOM from 'react-dom/client';
import Popup from '../popup/Popup';
import '../styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Popup isSidePanel />
  </React.StrictMode>
);
