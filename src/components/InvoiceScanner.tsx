"use client";

import { useState, useRef, useCallback } from "react";

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

interface InvoiceScannerProps {
    onScanComplete: (data: ScannedInvoiceData) => void;
    onError?: (error: string) => void;
}

type ScanStatus = "idle" | "uploading" | "scanning" | "done" | "error";

export default function InvoiceScanner({ onScanComplete, onError }: InvoiceScannerProps) {
    const [status, setStatus] = useState<ScanStatus>("idle");
    const [progress, setProgress] = useState("");
    const [dragActive, setDragActive] = useState(false);
    const [fileName, setFileName] = useState("");
    const [confidence, setConfidence] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFile = useCallback(async (file: File) => {
        // Validate on client side too
        const allowedTypes = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic"];
        if (!allowedTypes.includes(file.type)) {
            const msg = "Formato no soportado. Sube un PDF o imagen (PNG, JPG, WebP).";
            setStatus("error");
            setProgress(msg);
            onError?.(msg);
            return;
        }

        if (file.size > 20 * 1024 * 1024) {
            const msg = "El archivo es demasiado grande. Máximo 20 MB.";
            setStatus("error");
            setProgress(msg);
            onError?.(msg);
            return;
        }

        setFileName(file.name);
        setStatus("uploading");
        setProgress("Subiendo documento...");
        setConfidence(null);

        try {
            const formData = new FormData();
            formData.append("file", file);

            setStatus("scanning");
            setProgress("Analizando factura con IA... Esto puede tardar unos segundos.");

            const res = await fetch("/api/purchases/scan", {
                method: "POST",
                body: formData,
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Error al escanear");
            }

            const data: ScannedInvoiceData = await res.json();

            setStatus("done");
            setConfidence(data.confidence);
            setProgress(
                data.confidence >= 80
                    ? "✓ Factura analizada con alta confianza"
                    : data.confidence >= 50
                        ? "⚠ Factura analizada. Revisa los datos extraídos."
                        : "⚠ Baja confianza en la extracción. Verifica todos los campos."
            );

            onScanComplete(data);
        } catch (err: any) {
            setStatus("error");
            setProgress(err.message || "Error al escanear la factura");
            onError?.(err.message);
        }
    }, [onScanComplete, onError]);

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files?.[0]) {
            handleFile(e.dataTransfer.files[0]);
        }
    }, [handleFile]);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            handleFile(e.target.files[0]);
        }
    }, [handleFile]);

    const reset = () => {
        setStatus("idle");
        setProgress("");
        setFileName("");
        setConfidence(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const isProcessing = status === "uploading" || status === "scanning";

    return (
        <div className="invoice-scanner">
            <div
                className={`scanner-dropzone ${dragActive ? "scanner-dropzone-active" : ""} ${status === "done" ? "scanner-dropzone-done" : ""} ${status === "error" ? "scanner-dropzone-error" : ""}`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => !isProcessing && fileInputRef.current?.click()}
                style={{ cursor: isProcessing ? "wait" : "pointer" }}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                    onChange={handleInputChange}
                    style={{ display: "none" }}
                />

                {status === "idle" && (
                    <div className="scanner-content">
                        <div className="scanner-icon">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                                <line x1="16" y1="13" x2="8" y2="13" />
                                <line x1="16" y1="17" x2="8" y2="17" />
                                <polyline points="10 9 9 9 8 9" />
                            </svg>
                        </div>
                        <p className="scanner-title">Escanear factura con IA</p>
                        <p className="scanner-subtitle">
                            Arrastra un PDF o imagen aquí, o haz clic para seleccionar
                        </p>
                        <p className="scanner-hint">PDF, PNG, JPG, WebP — Máx. 20 MB</p>
                    </div>
                )}

                {isProcessing && (
                    <div className="scanner-content">
                        <div className="scanner-spinner" />
                        <p className="scanner-title">{progress}</p>
                        {fileName && <p className="scanner-subtitle">{fileName}</p>}
                    </div>
                )}

                {status === "done" && (
                    <div className="scanner-content">
                        <div className="scanner-icon scanner-icon-success">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                <polyline points="22 4 12 14.01 9 11.01" />
                            </svg>
                        </div>
                        <p className="scanner-title">{progress}</p>
                        {confidence !== null && (
                            <div className="scanner-confidence">
                                <div className="scanner-confidence-bar">
                                    <div
                                        className="scanner-confidence-fill"
                                        style={{
                                            width: `${confidence}%`,
                                            backgroundColor: confidence >= 80 ? "var(--color-success, #22c55e)" : confidence >= 50 ? "var(--color-warning, #f59e0b)" : "var(--color-error, #ef4444)"
                                        }}
                                    />
                                </div>
                                <span className="scanner-confidence-label">{confidence}% confianza</span>
                            </div>
                        )}
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={(e) => { e.stopPropagation(); reset(); }}
                            style={{ marginTop: 8 }}
                        >
                            Escanear otra factura
                        </button>
                    </div>
                )}

                {status === "error" && (
                    <div className="scanner-content">
                        <div className="scanner-icon scanner-icon-error">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" />
                                <line x1="15" y1="9" x2="9" y2="15" />
                                <line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                        </div>
                        <p className="scanner-title">{progress}</p>
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={(e) => { e.stopPropagation(); reset(); }}
                            style={{ marginTop: 8 }}
                        >
                            Reintentar
                        </button>
                    </div>
                )}
            </div>

            <style jsx>{`
                .invoice-scanner {
                    margin-bottom: 20px;
                }
                .scanner-dropzone {
                    border: 2px dashed var(--border-color, #d1d5db);
                    border-radius: 12px;
                    padding: 32px 24px;
                    text-align: center;
                    transition: all 0.25s ease;
                    background: var(--bg-card, #fff);
                    position: relative;
                    overflow: hidden;
                }
                .scanner-dropzone::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    background: linear-gradient(135deg, rgba(27, 22, 96, 0.02), rgba(99, 102, 241, 0.04));
                    opacity: 0;
                    transition: opacity 0.25s ease;
                }
                .scanner-dropzone:hover::before,
                .scanner-dropzone-active::before {
                    opacity: 1;
                }
                .scanner-dropzone:hover {
                    border-color: var(--color-primary, #1B1660);
                    box-shadow: 0 0 0 3px rgba(27, 22, 96, 0.08);
                }
                .scanner-dropzone-active {
                    border-color: var(--color-primary, #1B1660);
                    border-style: solid;
                    box-shadow: 0 0 0 4px rgba(27, 22, 96, 0.12);
                    transform: scale(1.01);
                }
                .scanner-dropzone-done {
                    border-color: var(--color-success, #22c55e);
                    background: linear-gradient(135deg, rgba(34, 197, 94, 0.03), rgba(34, 197, 94, 0.06));
                }
                .scanner-dropzone-error {
                    border-color: var(--color-error, #ef4444);
                    background: linear-gradient(135deg, rgba(239, 68, 68, 0.03), rgba(239, 68, 68, 0.06));
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
                    color: var(--text-secondary, #6b7280);
                    margin-bottom: 8px;
                    opacity: 0.7;
                }
                .scanner-icon-success {
                    color: var(--color-success, #22c55e);
                    opacity: 1;
                }
                .scanner-icon-error {
                    color: var(--color-error, #ef4444);
                    opacity: 1;
                }
                .scanner-title {
                    font-size: 15px;
                    font-weight: 600;
                    color: var(--text-primary, #111827);
                    margin: 0;
                }
                .scanner-subtitle {
                    font-size: 13px;
                    color: var(--text-secondary, #6b7280);
                    margin: 0;
                }
                .scanner-hint {
                    font-size: 11px;
                    color: var(--text-tertiary, #9ca3af);
                    margin: 4px 0 0;
                }
                .scanner-spinner {
                    width: 48px;
                    height: 48px;
                    border: 3px solid var(--border-color, #d1d5db);
                    border-top-color: var(--color-primary, #1B1660);
                    border-radius: 50%;
                    animation: scanner-spin 0.8s linear infinite;
                    margin-bottom: 12px;
                }
                .scanner-confidence {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-top: 8px;
                }
                .scanner-confidence-bar {
                    width: 120px;
                    height: 6px;
                    background: var(--border-color, #e5e7eb);
                    border-radius: 3px;
                    overflow: hidden;
                }
                .scanner-confidence-fill {
                    height: 100%;
                    border-radius: 3px;
                    transition: width 0.6s ease;
                }
                .scanner-confidence-label {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--text-secondary, #6b7280);
                }
                @keyframes scanner-spin {
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div>
    );
}
