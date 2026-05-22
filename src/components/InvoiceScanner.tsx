"use client";

import { useCallback, useRef, useState } from "react";

// ============================================================
// Tipos compartidos del escaneo.
// Los mantenemos exportados aquí porque otros componentes
// (EscanerQueueModal, /purchases/new) los siguen importando.
// ============================================================

interface ScannedLineItem {
    description: string;
    details: string;
    quantity: number;
    unitPriceEuros: number;
    taxRatePercent: number;
}

export interface ScannedAttachment {
    storagePath: string;
    publicUrl: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
}

export interface ScannedInvoiceData {
    providerName: string;
    providerTaxId: string;
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    lines: ScannedLineItem[];
    notes: string;
    /** % de retención IRPF detectado en el documento (0 si no hay). */
    retentionPct: number;
    /** Importe de retención en euros (0 si no hay). */
    retentionEuros: number;
    confidence: number;
    /** Avisos detectados por la IA (totales que no cuadran, retenciones, campos vacíos, etc.). */
    warnings: string[];
    /** Archivo subido a Supabase Storage durante el escaneo. */
    attachment: ScannedAttachment | null;
}

// ============================================================
// InvoiceScanner: dropzone multi-archivo.
//
// Ya no escanea internamente. Solo recoge los archivos y los pasa
// al padre vía `onFilesSelected`. El padre (EscanerQueueModal) se
// encarga del pool de procesado, timeouts y revisión.
// ============================================================

interface InvoiceScannerProps {
    onFilesSelected: (files: File[]) => void;
    onError?: (error: string) => void;
}

const ALLOWED_TYPES = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/heic",
];
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB por archivo

export default function InvoiceScanner({ onFilesSelected, onError }: InvoiceScannerProps) {
    const [dragActive, setDragActive] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const validateAndForward = useCallback(
        (files: File[]) => {
            const valid: File[] = [];
            for (const f of files) {
                if (!ALLOWED_TYPES.includes(f.type)) {
                    onError?.(`«${f.name}»: formato no soportado. Sube PDF o imagen.`);
                    continue;
                }
                if (f.size > MAX_BYTES) {
                    onError?.(`«${f.name}»: demasiado grande (máx. 20 MB).`);
                    continue;
                }
                valid.push(f);
            }
            if (valid.length > 0) onFilesSelected(valid);
        },
        [onFilesSelected, onError]
    );

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
        else if (e.type === "dragleave") setDragActive(false);
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDragActive(false);
            if (e.dataTransfer.files?.length) {
                validateAndForward(Array.from(e.dataTransfer.files));
            }
        },
        [validateAndForward]
    );

    const handleInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            if (e.target.files?.length) {
                validateAndForward(Array.from(e.target.files));
            }
            // Reset para poder volver a seleccionar el mismo archivo
            if (fileInputRef.current) fileInputRef.current.value = "";
        },
        [validateAndForward]
    );

    return (
        <div className="invoice-scanner">
            <div
                className={`scanner-dropzone ${dragActive ? "scanner-dropzone-active" : ""}`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{ cursor: "pointer" }}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                    multiple
                    onChange={handleInputChange}
                    style={{ display: "none" }}
                />

                <div className="scanner-content">
                    <div className="scanner-icon">
                        <svg
                            width="48"
                            height="48"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                            <polyline points="10 9 9 9 8 9" />
                        </svg>
                    </div>
                    <p className="scanner-title">Escanear facturas con IA</p>
                    <p className="scanner-subtitle">
                        Arrastra uno o varios PDFs/imágenes aquí, o haz clic para seleccionar
                    </p>
                    <p className="scanner-hint">
                        PDF, PNG, JPG, WebP — Máx. 20 MB por archivo · Procesa hasta 3 a la vez
                    </p>
                </div>
            </div>

            <style jsx>{`
                .invoice-scanner {
                    margin-bottom: 20px;
                }
                .scanner-dropzone {
                    border: 2px dashed var(--color-border, #d1d5db);
                    border-radius: 12px;
                    padding: 32px 24px;
                    text-align: center;
                    transition: all 0.25s ease;
                    background: var(--color-surface, #fff);
                    position: relative;
                    overflow: hidden;
                }
                .scanner-dropzone::before {
                    content: "";
                    position: absolute;
                    inset: 0;
                    background: linear-gradient(
                        135deg,
                        rgba(99, 102, 241, 0.04),
                        rgba(139, 92, 246, 0.06)
                    );
                    opacity: 0;
                    transition: opacity 0.25s ease;
                }
                .scanner-dropzone:hover::before,
                .scanner-dropzone-active::before {
                    opacity: 1;
                }
                .scanner-dropzone:hover {
                    border-color: var(--color-primary, #6366f1);
                    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08);
                }
                .scanner-dropzone-active {
                    border-color: var(--color-primary, #6366f1);
                    border-style: solid;
                    box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.12);
                    transform: scale(1.01);
                }
                .scanner-content {
                    position: relative;
                    z-index: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 4px;
                }
                .scanner-icon {
                    color: var(--color-text-secondary, #94a3b8);
                    margin-bottom: 8px;
                    opacity: 0.7;
                }
                .scanner-title {
                    font-size: 15px;
                    font-weight: 600;
                    color: var(--color-text, #f1f5f9);
                    margin: 0;
                }
                .scanner-subtitle {
                    font-size: 13px;
                    color: var(--color-text-secondary, #94a3b8);
                    margin: 0;
                }
                .scanner-hint {
                    font-size: 11px;
                    color: var(--color-text-muted, #64748b);
                    margin: 4px 0 0;
                }
            `}</style>
        </div>
    );
}
