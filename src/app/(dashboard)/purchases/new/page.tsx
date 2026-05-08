"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useNotification } from "@/components/NotificationContext";
import ProviderModal, { type ProviderModalInitialData } from "@/components/ProviderModal";
import InvoiceScanner, { type ScannedInvoiceData } from "@/components/InvoiceScanner";
import EscanerReviewModal from "@/components/EscanerReviewModal";

interface Provider {
    id: string;
    name: string;
    taxId?: string | null;
}

interface Tax {
    id: string;
    name: string;
    rate: number;
    type: string;
}

interface LineItem {
    key: string;
    description: string;
    details: string;
    quantity: string;
    unitPriceEuros: string;
    taxId: string;
    taxRate: number;
}

function newLine(): LineItem {
    return {
        key: crypto.randomUUID(),
        description: "",
        details: "",
        quantity: "1",
        unitPriceEuros: "",
        taxId: "",
        taxRate: 0,
    };
}

// ── Retention options (IRPF) ────────────────────────────
const RETENTION_OPTIONS = [
    { label: "Sin retención", value: 0 },
    { label: "IRPF 1%", value: 1 },
    { label: "IRPF 2%", value: 2 },
    { label: "IRPF 7%", value: 7 },
    { label: "IRPF 15%", value: 15 },
    { label: "IRPF 19%", value: 19 },
];

function LineItemEditor({
    line,
    taxes,
    updateLine,
    removeLine,
}: {
    line: LineItem;
    taxes: Tax[];
    updateLine: (key: string, field: string, value: string) => void;
    removeLine: (key: string) => void;
}) {
    const ivaTaxes = taxes.filter(t => t.type === "IVA" || t.type === "EXENTO" || t.type === "RECARGO_EQUIVALENCIA" || t.type === "INTRACOMUNITARIO");

    const qty = parseFloat(line.quantity) || 0;
    const unitEuros = parseFloat(line.unitPriceEuros) || 0;
    const subtotalEuros = qty * unitEuros;
    const taxEuros = subtotalEuros * line.taxRate / 100;
    const totalEuros = subtotalEuros + taxEuros;

    return (
        <div className="line-row" key={line.key}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '2 1 200px', minWidth: 180 }}>
                <input
                    className="line-input"
                    placeholder="Concepto (ej: Servicio de diseño web)"
                    value={line.description}
                    onChange={(e) => updateLine(line.key, "description", e.target.value)}
                    style={{ fontWeight: 600 }}
                />
                <textarea
                    className="line-input line-details"
                    placeholder="Descripción adicional (opcional)"
                    value={line.details}
                    onChange={(e) => updateLine(line.key, "details", e.target.value)}
                    rows={1}
                />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 70, flex: '0 0 80px' }}>
                <label className="line-field-label">Cantidad</label>
                <input
                    className="line-input line-input-sm"
                    type="number"
                    placeholder="1"
                    value={line.quantity}
                    onChange={(e) => updateLine(line.key, "quantity", e.target.value)}
                    min="0"
                    step="1"
                />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 100, flex: '0 0 110px' }}>
                <label className="line-field-label">Precio (€)</label>
                <input
                    className="line-input line-input-sm"
                    type="number"
                    placeholder="0.00"
                    value={line.unitPriceEuros}
                    onChange={(e) => updateLine(line.key, "unitPriceEuros", e.target.value)}
                    min="0"
                    step="0.01"
                />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 100, flex: '0 0 130px' }}>
                <label className="line-field-label">IVA</label>
                <select
                    className="line-input"
                    value={line.taxId}
                    onChange={(e) => updateLine(line.key, "taxId", e.target.value)}
                >
                    <option value="">Sin IVA</option>
                    {ivaTaxes.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 90, flex: '0 0 90px', textAlign: 'right' }}>
                <label className="line-field-label">Total línea</label>
                <span className="line-total">{totalEuros.toFixed(2)} €</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeLine(line.key)} style={{ alignSelf: 'center', marginTop: 16 }}>✕</button>

            <style jsx>{`
                .line-field-label {
                    font-size: 10px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: var(--text-tertiary, #9ca3af);
                    margin: 0;
                }
            `}</style>
        </div>
    );
}

export default function NewPurchasePage() {
    const router = useRouter();
    const { showError, showSuccess } = useNotification();
    const [providers, setProviders] = useState<Provider[]>([]);
    const [taxes, setTaxes] = useState<Tax[]>([]);
    const [providerId, setProviderId] = useState("");
    const [providerInvoiceNumber, setProviderInvoiceNumber] = useState("");
    const [issueDate, setIssueDate] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [notes, setNotes] = useState("");
    const [lines, setLines] = useState<LineItem[]>([newLine()]);
    const [saving, setSaving] = useState(false);
    const [showProviderModal, setShowProviderModal] = useState(false);
    const [showScanner, setShowScanner] = useState(true);
    const [providerModalInitial, setProviderModalInitial] = useState<ProviderModalInitialData | undefined>(undefined);
    const [retentionPct, setRetentionPct] = useState(0);
    // Datos del escaneo: cuando llegan, abren el modal de revisión.
    const [scanData, setScanData] = useState<ScannedInvoiceData | null>(null);

    useEffect(() => {
        fetch("/api/providers").then((r) => r.json()).then((d) => setProviders(Array.isArray(d) ? d : []));
        fetch("/api/taxes").then((r) => r.json()).then((d) => setTaxes(Array.isArray(d) ? d : []));
    }, []);

    // ── Handle scanned invoice data ────────────────────────
    // Cuando termina el escaneo, abrimos el modal de revisión.
    // El modal se encarga de match/creación de proveedor, edición y guardado.
    function handleScanComplete(data: ScannedInvoiceData) {
        setScanData(data);
    }

    function updateLine(key: string, field: string, value: string) {
        setLines((prev) =>
            prev.map((l) => {
                if (l.key !== key) return l;
                const updated = { ...l, [field]: value };
                if (field === "taxId") {
                    const foundTax = taxes.find((t) => t.id === value);
                    updated.taxRate = foundTax?.rate || 0;
                }
                return updated;
            })
        );
    }

    function removeLine(key: string) {
        setLines((prev) => prev.filter((l) => l.key !== key));
    }

    // ── Calculate totals (in euros for display) ────────────
    const subtotalEuros = lines.reduce((sum, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const unit = parseFloat(l.unitPriceEuros) || 0;
        return sum + qty * unit;
    }, 0);

    const taxEuros = lines.reduce((sum, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const unit = parseFloat(l.unitPriceEuros) || 0;
        const sub = qty * unit;
        return sum + sub * l.taxRate / 100;
    }, 0);

    const retentionEuros = subtotalEuros * retentionPct / 100;
    const totalEuros = subtotalEuros + taxEuros - retentionEuros;

    async function handleSave() {
        if (!providerId) {
            showError("Selecciona un proveedor");
            return;
        }
        if (lines.length === 0 || !lines.some((l) => l.description.trim())) {
            showError("Añade al menos una línea con descripción");
            return;
        }

        setSaving(true);

        try {
            const res = await fetch("/api/purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    providerId,
                    providerInvoiceNumber: providerInvoiceNumber || null,
                    issueDate: issueDate || null,
                    dueDate: dueDate || null,
                    notes: notes || null,
                    retentionPct,
                    lines: lines.map((l) => ({
                        description: l.description,
                        details: l.details || null,
                        quantity: l.quantity,
                        unitPriceEuros: l.unitPriceEuros,
                        taxId: l.taxId || null,
                        taxRate: l.taxRate,
                    })),
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Error al crear");
            }

            const purchase = await res.json();
            router.push(`/purchases/${purchase.id}`);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <div className="page-header">
                <div>
                    <h1>Nueva Factura de Proveedor</h1>
                    <p className="page-header-sub">Registra una factura recibida de un proveedor</p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setShowScanner(!showScanner)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                        </svg>
                        {showScanner ? 'Ocultar escáner' : 'Escanear factura'}
                    </button>
                    <Link href="/purchases" className="btn btn-secondary">
                        ← Volver
                    </Link>
                </div>
            </div>

            {showScanner && (
                <InvoiceScanner
                    onScanComplete={handleScanComplete}
                    onError={(msg) => showError(msg)}
                />
            )}

            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-body">
                    <div className="form-row">
                        <div className="form-group" style={{ flex: 2 }}>
                            <div className="flex justify-between items-center mb-1">
                                <label className="form-label" style={{ marginBottom: 0 }}>Proveedor *</label>
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                        setProviderModalInitial(undefined);
                                        setShowProviderModal(true);
                                    }}
                                    style={{ padding: '0 4px', fontSize: '11.5px', color: 'var(--color-primary)' }}
                                >
                                    + Nuevo Proveedor
                                </button>
                            </div>
                            <select
                                className="form-input"
                                value={providerId}
                                onChange={(e) => setProviderId(e.target.value)}
                            >
                                <option value="">Seleccionar proveedor...</option>
                                {providers.map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Nº Factura Proveedor</label>
                            <input
                                type="text"
                                className="form-input"
                                placeholder="Ej: FA-2024-001"
                                value={providerInvoiceNumber}
                                onChange={(e) => setProviderInvoiceNumber(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Fecha Factura</label>
                            <input
                                type="date"
                                className="form-input"
                                value={issueDate}
                                onChange={(e) => setIssueDate(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label className="form-label">Fecha Vencimiento</label>
                            <input
                                type="date"
                                className="form-input"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Lines */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header">
                    <h3 style={{ margin: 0 }}>Líneas de factura</h3>
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setLines([...lines, newLine()])}
                    >
                        + Añadir línea
                    </button>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                    {lines.map((line) => (
                        <LineItemEditor
                            key={line.key}
                            line={line}
                            taxes={taxes}
                            updateLine={updateLine}
                            removeLine={removeLine}
                        />
                    ))}
                    {lines.length === 0 && (
                        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-tertiary, #9ca3af)', fontSize: 13 }}>
                            No hay líneas. Haz clic en &quot;+ Añadir línea&quot; para empezar.
                        </div>
                    )}
                </div>
            </div>

            {/* Retention + Totals */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-body">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
                        {/* Retention selector */}
                        <div className="form-group" style={{ minWidth: 200, maxWidth: 280, margin: 0 }}>
                            <label className="form-label">Retención IRPF</label>
                            <select
                                className="form-input"
                                value={retentionPct}
                                onChange={(e) => setRetentionPct(parseFloat(e.target.value))}
                            >
                                {RETENTION_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                            <p style={{ fontSize: 11, color: 'var(--text-tertiary, #9ca3af)', margin: '4px 0 0' }}>
                                Se aplica sobre la base imponible
                            </p>
                        </div>

                        {/* Totals */}
                        <div className="totals-grid" style={{ minWidth: 250 }}>
                            <div className="totals-row">
                                <span>Base imponible</span>
                                <span className="cell-mono">{subtotalEuros.toFixed(2)} €</span>
                            </div>
                            <div className="totals-row">
                                <span>IVA</span>
                                <span className="cell-mono" style={{ color: 'var(--color-success, #22c55e)' }}>+{taxEuros.toFixed(2)} €</span>
                            </div>
                            {retentionPct > 0 && (
                                <div className="totals-row">
                                    <span>Retención IRPF ({retentionPct}%)</span>
                                    <span className="cell-mono" style={{ color: 'var(--color-error, #ef4444)' }}>-{retentionEuros.toFixed(2)} €</span>
                                </div>
                            )}
                            <div className="totals-row totals-total">
                                <span>Total</span>
                                <span className="cell-mono">{totalEuros.toFixed(2)} €</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Notes */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-body">
                    <div className="form-group">
                        <label className="form-label">Notas internas</label>
                        <textarea
                            className="form-textarea"
                            placeholder="Notas sobre esta factura..."
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="form-actions">
                <button
                    className="btn btn-primary btn-lg"
                    onClick={handleSave}
                    disabled={saving}
                >
                    {saving ? "Guardando..." : "Guardar Borrador"}
                </button>
                <Link href="/purchases" className="btn btn-secondary">
                    Cancelar
                </Link>
            </div>
            <ProviderModal
                isOpen={showProviderModal}
                onClose={() => {
                    setShowProviderModal(false);
                    setProviderModalInitial(undefined);
                }}
                onSuccess={(provider) => {
                    setProviders((prev) => [...prev, provider]);
                    setProviderId(provider.id);
                    setProviderModalInitial(undefined);
                }}
                initialData={providerModalInitial}
            />

            {/* Modal de revisión post-escaneo (PDF + form completo) */}
            <EscanerReviewModal
                isOpen={!!scanData}
                scanData={scanData}
                providers={providers}
                taxes={taxes}
                onClose={() => setScanData(null)}
                onSaved={(purchaseId) => {
                    showSuccess("Factura creada desde escaneo");
                    setScanData(null);
                    router.push(`/purchases/${purchaseId}`);
                }}
                onProvidersChanged={setProviders}
                onError={(msg) => showError(msg)}
            />
        </>
    );
}
