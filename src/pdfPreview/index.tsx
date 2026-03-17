import React from 'react';
import ReactDOM from 'react-dom/client';
import PdfPreviewPage from './PdfPreviewPage';
import '../styles/index.css';
import './pdfPreview.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PdfPreviewPage />
  </React.StrictMode>
);
