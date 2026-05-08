"use client";

// ============================================================
// EscanerReviewModal — vista de revisión post-escaneo.
//
// Se abre cuando InvoiceScanner termina de escanear una factura.
// Muestra el documento original (PDF/imagen) a la izquierda y un
// formulario editable a la derecha con TODOS los campos del modelo
// `PurchaseInvoice` de Automatio, listos para confirmar o descartar.
//
// Diseño inspirado en el DetailPanel de CRM Dani, adaptado al tema
// premium dark de Automatio (indigo + Inter + paleta `--color-*`).
// ============================================================

import { useEffect, useMemo, useState } from "react";
import type { ScannedInvoiceData } from "@/components/InvoiceScanner";

interface Provider {
    id: string;
    name: string;
    taxId?: string | null;
}

interface Tax {
    id: string;
    name: string;
    rate: number;
}

interface LineItem {
    key: string;
    description: string;
    details: string;
    quantity: string;       // string para inputs controlados
    unitPriceEuros: string; // euros como string (ej. "100.50") — convertimos a céntimos al enviar
    taxId: string;
    taxRate: number;        // resuelto desde taxes
}

type Status = "DRAFT" | "BOOKED" | "PAID";

const STATUSES: { id: Status; label: string; dot: string }[] = [
    { id: "DRAFT", label: "Borrador", dot: "var(--color-text-muted)" },
    { id: "BOOKED", label: "Contabilizada", dot: "var(--color-warning)" },
    { id: "PAID", label: "Pagada", dot: "var(--color-success)" },
];

interface EscanerReviewModalProps {
    isOpen: boolean;
    scanData: ScannedInvoiceData | null;
    providers: Provider[];
    taxes: Tax[];
    onClose: () => void;
    onSaved: (purchaseId: string) => void;
    onProvidersChanged?: (providers: Provider[]) => void;
    onError?: (message: string) => void;
}

export default function EscanerReviewModal({
    isOpen,
    scanData,
    providers,
    taxes,
    onClose,
    onSaved,
    onProvidersChanged,
    onError,
}: EscanerReviewModalProps) {
    // ── State del formulario ────────────────────────────────
    const [providerId, setProviderId] = useState("");
    const [providerName, setProviderName] = useState("");
    const [providerTaxId, setProviderTaxId] = useState("");
    const [providerAutoCreated, setProviderAutoCreated] = useState(false);
    const [invoiceNumber, setInvoiceNumber] = useState("");
    const [issueDate, setIssueDate] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [status, setStatus] = useState<Status>("DRAFT");
    // Retención IRPF: % es la fuente de verdad. El € se calcula a partir
    // del subtotal × %. Si el usuario edita el €, recalculamos el %.
    const [retentionPct, setRetentionPct] = useState<number>(0);
    const [notes, setNotes] = useState("");
    const [lines, setLines] = useState<LineItem[]>([]);
    const [saving, setSaving] = useState(false);

    // Inicializar el formulario cada vez que llegan datos nuevos del escaneo
    useEffect(() => {
        if (!isOpen || !scanData) return;

        // Match de proveedor: NIF primero, luego nombre
        const normalize = (s: string) => s.replace(/[\s\-.]/g, "").toLowerCase();
        const nifNorm = scanData.providerTaxId ? normalize(scanData.providerTaxId) : "";
        const nameNorm = scanData.providerName ? normalize(scanData.providerName) : "";

        let matched: Provider | undefined;
        if (nifNorm) matched = providers.find((p) => p.taxId && normalize(p.taxId) === nifNorm);
        if (!matched && nameNorm) {
            matched = providers.find((p) => {
                const pn = normalize(p.name);
                return pn === nameNorm || pn.includes(nameNorm) || nameNorm.includes(pn);
            });
        }

        setProviderId(matched?.id || "");
        setProviderName(scanData.providerName || matched?.name || "");
        setProviderTaxId(scanData.providerTaxId || matched?.taxId || "");
        setProviderAutoCreated(false);
        setInvoiceNumber(scanData.invoiceNumber || "");
        setIssueDate(scanData.issueDate || "");
        setDueDate(scanData.dueDate || "");
        setStatus("DRAFT");
        // Inicializar retención: si Claude detectó un %, lo usamos.
        // Si no, intentamos derivarlo del importe en euros y el subtotal del documento.
        const detectedPct = Number(scanData.retentionPct) || 0;
        setRetentionPct(Math.max(0, Math.min(100, detectedPct)));
        setNotes(scanData.notes || "");

        const initialLines: LineItem[] = (scanData.lines || []).map((sl) => {
            const matchedTax = taxes.find((t) => Math.abs(t.rate - sl.taxRatePercent) < 0.5);
            return {
                key: crypto.randomUUID(),
                description: sl.description || "",
                details: sl.details || "",
                quantity: String(sl.quantity || 1),
                unitPriceEuros: (sl.unitPriceEuros || 0).toFixed(2),
                taxId: matchedTax?.id || "",
                taxRate: matchedTax?.rate || sl.taxRatePercent || 0,
            };
        });
        setLines(initialLines.length > 0 ? initialLines : [emptyLine()]);
    }, [isOpen, scanData, providers, taxes]);

    // ── Cálculos de totales ─────────────────────────────────
    const totals = useMemo(() => computeTotals(lines, retentionPct), [lines, retentionPct]);

    if (!isOpen || !scanData) return null;

    const matchedProvider = providers.find((p) => p.id === providerId);
    const isImage = scanData.attachment?.mimeType.startsWith("image/");
    const isPdf = scanData.attachment?.mimeType === "application/pdf";
    const previewUrl = scanData.attachment?.publicUrl || null;
    const filename = scanData.attachment?.filename || "Documento";

    // ── Acciones ────────────────────────────────────────────
    function updateLine(key: string, field: keyof LineItem, value: string) {
        setLines((prev) =>
            prev.map((l) => {
                if (l.key !== key) return l;
                const updated = { ...l, [field]: value };
                if (field === "taxId") {
                    const t = taxes.find((tt) => tt.id === value);
                    updated.taxRate = t?.rate || 0;
                }
                return updated;
            })
        );
    }

    function addLine() {
        setLines((prev) => [...prev, emptyLine()]);
    }
    function removeLine(key: string) {
        setLines((prev) => prev.filter((l) => l.key !== key));
    }

    async function handleAutoCreateProvider() {
        if (!providerName.trim()) {
            onError?.("Hace falta un nombre para crear el proveedor.");
            return;
        }
        try {
            const res = await fetch("/api/providers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: providerName.trim(),
                    taxId: providerTaxId.trim() || null,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Error al crear el proveedor");
            }
            const newProvider: Provider = await res.json();
            const next = [newProvider, ...providers];
            onProvidersChanged?.(next);
            setProviderId(newProvider.id);
            setProviderAutoCreated(true);
        } catch (e) {
            onError?.(e instanceof Error ? e.message : "Error al crear el proveedor");
        }
    }

    async function handleConfirm() {
        if (!providerId) {
            onError?.("Selecciona o crea un proveedor antes de confirmar.");
            return;
        }
        if (lines.length === 0 || !lines.some((l) => l.description.trim())) {
            onError?.("Añade al menos una línea con descripción.");
            return;
        }

        setSaving(true);
        try {
            const res = await fetch("/api/purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    providerId,
                    providerInvoiceNumber: invoiceNumber || null,
                    issueDate: issueDate || null,
                    dueDate: dueDate || null,
                    notes: notes || null,
                    status,
                    retentionPct,
                    lines: lines.map((l) => ({
                        description: l.description,
                        details: l.details || null,
                        quantity: l.quantity,
                        // Convertimos euros → céntimos justo antes de enviar.
                        unitPriceCents: String(Math.round((parseFloat(l.unitPriceEuros) || 0) * 100)),
                        taxId: l.taxId || null,
                        taxRate: l.taxRate,
                    })),
                    attachment: scanData?.attachment ?? null,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Error al crear la factura");
            }
            const purchase = await res.json();
            onSaved(purchase.id);
        } catch (e) {
            onError?.(e instanceof Error ? e.message : "Error al guardar");
        } finally {
            setSaving(false);
        }
    }

    // ── Render ──────────────────────────────────────────────
    return (
        <div
            className="modal-overlay"
            onClick={() => !saving && onClose()}
            style={{ padding: 24 }}
        >
            <div
                className="modal-content escaner-modal"
                onClick={(e) => e.stopPropagation()}
                style={{
                    maxWidth: "1280px",
                    width: "95vw",
                    height: "90vh",
                    maxHeight: "90vh",
                }}
            >
                {/* ── Cabecera ───────────────────────────────── */}
                <div
                    className="modal-header"
                    style={{
                        gap: 16,
                        flexShrink: 0,
                    }}
                >
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                            className="modal-title"
                            style={{
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                        >
                            {filename}
                        </div>
                        <div
                            style={{
                                fontSize: 12,
                                color: "var(--color-text-muted)",
                                marginTop: 4,
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                flexWrap: "wrap",
                            }}
                        >
                            <span>Datos extraídos por IA · revisa y confirma</span>
                            <span>·</span>
                            <span>Claude Haiku 4.5</span>
                            {scanData.confidence != null && (
                                <>
                                    <span>·</span>
                                    <ConfidenceBadge confidence={scanData.confidence} />
                                </>
                            )}
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={onClose}
                            disabled={saving}
                        >
                            Descartar
                        </button>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={handleConfirm}
                            disabled={saving}
                        >
                            {saving ? "Creando…" : "Confirmar y crear factura"}
                        </button>
                        <button
                            className="btn-close"
                            onClick={onClose}
                            disabled={saving}
                            title="Cerrar"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* ── Avisos del escaneo ─────────────────────── */}
                {scanData.warnings && scanData.warnings.length > 0 && (
                    <div
                        style={{
                            padding: "10px 20px",
                            background: "var(--color-warning-muted)",
                            borderBottom: "1px solid var(--color-border-subtle)",
                            fontSize: 12.5,
                            color: "var(--color-warning)",
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 10,
                            flexShrink: 0,
                            lineHeight: 1.5,
                        }}
                    >
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ flexShrink: 0, marginTop: 2 }}
                        >
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <div>
                            <strong style={{ fontWeight: 600 }}>Avisos del escaneo:</strong>{" "}
                            {scanData.warnings.join(" · ")}
                        </div>
                    </div>
                )}

                {/* ── Cuerpo: split view ─────────────────────── */}
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "1.1fr 1fr",
                        flex: 1,
                        minHeight: 0,
                        overflow: "hidden",
                    }}
                >
                    {/* Preview */}
                    <div
                        style={{
                            borderRight: "1px solid var(--color-border-subtle)",
                            background: "var(--color-bg-secondary)",
                            padding: 16,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            overflow: "auto",
                        }}
                    >
                        {previewUrl ? (
                            isPdf ? (
                                <iframe
                                    src={previewUrl}
                                    title="Documento"
                                    style={{
                                        width: "100%",
                                        height: "100%",
                                        minHeight: 600,
                                        border: "1px solid var(--color-border)",
                                        borderRadius: "var(--radius-md)",
                                        background: "#fff",
                                    }}
                                />
                            ) : isImage ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                    src={previewUrl}
                                    alt="Documento"
                                    style={{
                                        maxWidth: "100%",
                                        maxHeight: "100%",
                                        borderRadius: "var(--radius-md)",
                                        boxShadow: "var(--shadow-md)",
                                    }}
                                />
                            ) : (
                                <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                                    Vista previa no disponible para este tipo de archivo
                                </div>
                            )
                        ) : (
                            <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
                                Sin documento adjunto
                            </div>
                        )}
                    </div>

                    {/* Formulario */}
                    <div
                        style={{
                            padding: 24,
                            display: "flex",
                            flexDirection: "column",
                            gap: 16,
                            overflow: "auto",
                        }}
                    >
                        {/* Proveedor */}
                        <Field label="Proveedor">
                            <select
                                className="form-input"
                                value={providerId}
                                onChange={(e) => setProviderId(e.target.value)}
                            >
                                <option value="">— Sin seleccionar —</option>
                                {providers.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                        {p.taxId ? ` (${p.taxId})` : ""}
                                    </option>
                                ))}
                            </select>
                            {!providerId && providerName.trim() && (
                                <div style={{ marginTop: 6 }}>
                                    <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        onClick={handleAutoCreateProvider}
                                        style={{
                                            fontSize: 12,
                                            color: "var(--color-primary)",
                                            padding: "4px 8px",
                                        }}
                                    >
                                        + Crear «{providerName}»
                                        {providerTaxId ? ` (${providerTaxId})` : ""}
                                    </button>
                                </div>
                            )}
                            {providerId && providerAutoCreated && (
                                <ProviderTag tone="primary">Proveedor creado automáticamente</ProviderTag>
                            )}
                            {providerId && !providerAutoCreated && matchedProvider && (
                                <ProviderTag tone="success">
                                    Coincide con: {matchedProvider.name}
                                </ProviderTag>
                            )}
                        </Field>

                        <div className="form-row">
                            <Field label="NIF / CIF (escaneado)">
                                <input
                                    type="text"
                                    className="form-input"
                                    value={providerTaxId}
                                    onChange={(e) => setProviderTaxId(e.target.value)}
                                    placeholder="—"
                                    disabled={!!providerId}
                                />
                            </Field>
                            <Field label="Nº factura proveedor">
                                <input
                                    type="text"
                                    className="form-input"
                                    value={invoiceNumber}
                                    onChange={(e) => setInvoiceNumber(e.target.value)}
                                    placeholder="Ej. FA-2026-001"
                                />
                            </Field>
                        </div>

                        <div className="form-row">
                            <Field label="Fecha emisión">
                                <input
                                    type="date"
                                    className="form-input"
                                    value={issueDate}
                                    onChange={(e) => setIssueDate(e.target.value)}
                                />
                            </Field>
                            <Field label="Fecha vencimiento">
                                <input
                                    type="date"
                                    className="form-input"
                                    value={dueDate}
                                    onChange={(e) => setDueDate(e.target.value)}
                                />
                            </Field>
                        </div>

                        <Field label="Estado">
                            <StatusPills value={status} onChange={setStatus} />
                        </Field>

                        <SectionDivider label="Líneas" />

                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {lines.map((line) => (
                                <ScanLineEditor
                                    key={line.key}
                                    line={line}
                                    taxes={taxes}
                                    onUpdate={(field, value) => updateLine(line.key, field, value)}
                                    onRemove={() => removeLine(line.key)}
                                />
                            ))}
                            <div>
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={addLine}
                                >
                                    + Añadir línea
                                </button>
                            </div>
                        </div>

                        <div
                            style={{
                                background: "var(--color-bg-tertiary)",
                                border: "1px solid var(--color-border)",
                                borderRadius: "var(--radius-md)",
                                padding: 14,
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                            }}
                        >
                            <Row label="Base imponible" value={fmtEuros(totals.subtotalCents)} />
                            <Row label="IVA" value={fmtEuros(totals.taxCents)} />
                            {retentionPct > 0 && (
                                <Row
                                    label={`Retención IRPF (${retentionPct}%)`}
                                    value={`− ${fmtEuros(totals.retentionCents)}`}
                                    tone="danger"
                                />
                            )}
                            <Row label="Total" value={fmtEuros(totals.totalCents)} bold />
                        </div>

                        {/* Retención IRPF: dos inputs en línea, mismo formato que NIF / Nº factura.
                            % es la fuente de verdad; el € se calcula y, si el usuario lo edita,
                            recalculamos el %. */}
                        <div className="form-row">
                            <Field label="Retención IRPF %">
                                <input
                                    type="number"
                                    className="form-input"
                                    value={retentionPct === 0 ? "" : String(retentionPct)}
                                    placeholder="0"
                                    min="0"
                                    max="100"
                                    step="0.01"
                                    onChange={(e) => {
                                        const v = parseFloat(e.target.value);
                                        if (!Number.isFinite(v)) {
                                            setRetentionPct(0);
                                        } else {
                                            setRetentionPct(Math.max(0, Math.min(100, v)));
                                        }
                                    }}
                                />
                            </Field>
                            <Field label="Retención €">
                                <input
                                    type="number"
                                    className="form-input"
                                    value={
                                        totals.retentionCents === 0
                                            ? ""
                                            : (totals.retentionCents / 100).toFixed(2)
                                    }
                                    placeholder="0.00"
                                    min="0"
                                    step="0.01"
                                    onChange={(e) => {
                                        const newEuros = parseFloat(e.target.value);
                                        if (!Number.isFinite(newEuros) || totals.subtotalCents === 0) {
                                            setRetentionPct(0);
                                            return;
                                        }
                                        // Recalcular el % a partir del nuevo importe en euros.
                                        const newPct = (newEuros * 100 * 100) / totals.subtotalCents;
                                        setRetentionPct(Math.max(0, Math.min(100, newPct)));
                                    }}
                                />
                            </Field>
                        </div>

                        <Field label="Notas">
                            <textarea
                                className="form-input"
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder="Notas internas sobre la factura"
                                rows={3}
                                style={{ minHeight: 70, resize: "vertical" }}
                            />
                        </Field>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ============================================================
// Subcomponentes
// ============================================================

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">{label}</label>
            {children}
        </div>
    );
}

function SectionDivider({ label }: { label: string }) {
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 6,
                marginBottom: -4,
            }}
        >
            <div
                style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: "var(--color-text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                }}
            >
                {label}
            </div>
            <div style={{ flex: 1, height: 1, background: "var(--color-border)" }} />
        </div>
    );
}

function StatusPills({
    value,
    onChange,
}: {
    value: Status;
    onChange: (v: Status) => void;
}) {
    return (
        <div
            style={{
                display: "flex",
                gap: 4,
                background: "var(--color-bg-tertiary)",
                padding: 3,
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
            }}
        >
            {STATUSES.map((s) => {
                const active = value === s.id;
                return (
                    <button
                        key={s.id}
                        type="button"
                        onClick={() => onChange(s.id)}
                        style={{
                            flex: 1,
                            padding: "7px 10px",
                            borderRadius: "var(--radius-sm)",
                            fontSize: 12.5,
                            fontWeight: 500,
                            background: active ? "var(--color-surface)" : "transparent",
                            color: active ? "var(--color-text)" : "var(--color-text-muted)",
                            boxShadow: active ? "var(--shadow-sm)" : "none",
                            border: "none",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 6,
                            transition: "var(--transition-fast)",
                        }}
                    >
                        <span
                            style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                background: s.dot,
                            }}
                        />
                        {s.label}
                    </button>
                );
            })}
        </div>
    );
}

function ProviderTag({
    children,
    tone,
}: {
    children: React.ReactNode;
    tone: "success" | "primary";
}) {
    const colors = {
        success: { bg: "var(--color-success-muted)", fg: "var(--color-success)" },
        primary: { bg: "var(--color-primary-muted)", fg: "var(--color-primary)" },
    }[tone];
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: 500,
                color: colors.fg,
                background: colors.bg,
                padding: "3px 9px",
                borderRadius: "var(--radius-full)",
                marginTop: 6,
            }}
        >
            {children}
        </span>
    );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
    const tone =
        confidence >= 80
            ? { fg: "var(--color-success)", bg: "var(--color-success-muted)" }
            : confidence >= 50
                ? { fg: "var(--color-warning)", bg: "var(--color-warning-muted)" }
                : { fg: "var(--color-danger)", bg: "var(--color-danger-muted)" };
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 7px",
                borderRadius: "var(--radius-full)",
                fontSize: 11,
                fontWeight: 600,
                color: tone.fg,
                background: tone.bg,
            }}
        >
            {confidence}% confianza
        </span>
    );
}

function ScanLineEditor({
    line,
    taxes,
    onUpdate,
    onRemove,
}: {
    line: LineItem;
    taxes: Tax[];
    onUpdate: (field: keyof LineItem, value: string) => void;
    onRemove: () => void;
}) {
    const qty = parseFloat(line.quantity) || 0;
    const unitCents = Math.round((parseFloat(line.unitPriceEuros) || 0) * 100);
    const sub = Math.round(qty * unitCents);
    const tax = Math.round((sub * line.taxRate) / 100);
    const total = sub + tax;

    return (
        <div
            style={{
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                padding: 12,
                background: "var(--color-bg-secondary)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
            }}
        >
            {/* Fila 1: Concepto a ancho completo + botón eliminar */}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                    <MiniLabel>Concepto</MiniLabel>
                    <input
                        className="form-input"
                        placeholder="Descripción de la línea"
                        value={line.description}
                        onChange={(e) => onUpdate("description", e.target.value)}
                        style={{ fontWeight: 600, fontSize: 14 }}
                    />
                </div>
                <button
                    type="button"
                    onClick={onRemove}
                    title="Eliminar línea"
                    style={{
                        marginTop: 22,
                        background: "transparent",
                        border: "1px solid var(--color-border)",
                        borderRadius: "var(--radius-sm)",
                        color: "var(--color-text-muted)",
                        cursor: "pointer",
                        padding: "6px 10px",
                        fontSize: 14,
                        flexShrink: 0,
                    }}
                >
                    ✕
                </button>
            </div>

            {/* Fila 2: Detalles a ancho completo */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <MiniLabel>Detalles</MiniLabel>
                <textarea
                    className="form-input"
                    placeholder="Detalles adicionales (opcional)"
                    value={line.details}
                    onChange={(e) => onUpdate("details", e.target.value)}
                    rows={1}
                    style={{
                        fontSize: 13,
                        minHeight: 36,
                        resize: "vertical",
                        lineHeight: 1.4,
                    }}
                />
            </div>

            {/* Fila 3: numéricos */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "70px 1fr 1.2fr 110px",
                    gap: 8,
                    alignItems: "end",
                }}
            >
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <MiniLabel>Uds</MiniLabel>
                    <input
                        className="form-input"
                        type="number"
                        value={line.quantity}
                        onChange={(e) => onUpdate("quantity", e.target.value)}
                        min="0"
                        step="1"
                    />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <MiniLabel>Precio (€)</MiniLabel>
                    <input
                        className="form-input"
                        type="number"
                        value={line.unitPriceEuros}
                        onChange={(e) => onUpdate("unitPriceEuros", e.target.value)}
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                    />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <MiniLabel>IVA</MiniLabel>
                    <select
                        className="form-input"
                        value={line.taxId}
                        onChange={(e) => onUpdate("taxId", e.target.value)}
                    >
                        <option value="">Sin IVA</option>
                        {taxes.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.name}
                            </option>
                        ))}
                    </select>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <MiniLabel>Total</MiniLabel>
                    <div
                        style={{
                            padding: "8px 10px",
                            background: "var(--color-bg-tertiary)",
                            border: "1px solid var(--color-border)",
                            borderRadius: "var(--radius-sm)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--color-text)",
                            textAlign: "right",
                        }}
                    >
                        {(total / 100).toFixed(2)} €
                    </div>
                </div>
            </div>
        </div>
    );
}

function MiniLabel({ children }: { children: React.ReactNode }) {
    return (
        <span
            style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: "var(--color-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
            }}
        >
            {children}
        </span>
    );
}

function Row({
    label,
    value,
    bold,
    tone,
}: {
    label: string;
    value: string;
    bold?: boolean;
    tone?: "default" | "danger";
}) {
    const color = bold
        ? "var(--color-text)"
        : tone === "danger"
            ? "var(--color-danger)"
            : "var(--color-text-secondary)";
    return (
        <div
            style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 13,
                fontWeight: bold ? 700 : 500,
                color,
                paddingTop: bold ? 6 : 0,
                borderTop: bold ? "1px solid var(--color-border)" : "none",
            }}
        >
            <span>{label}</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>{value}</span>
        </div>
    );
}

// ============================================================
// Helpers
// ============================================================

function emptyLine(): LineItem {
    return {
        key: crypto.randomUUID(),
        description: "",
        details: "",
        quantity: "1",
        unitPriceEuros: "0.00",
        taxId: "",
        taxRate: 0,
    };
}

function computeTotals(lines: LineItem[], retentionPct: number) {
    let subtotalCents = 0;
    let taxCents = 0;
    for (const l of lines) {
        const qty = parseFloat(l.quantity) || 0;
        // Calculamos en céntimos para evitar errores de coma flotante.
        const unitCents = Math.round((parseFloat(l.unitPriceEuros) || 0) * 100);
        const sub = Math.round(qty * unitCents);
        subtotalCents += sub;
        taxCents += Math.round((sub * l.taxRate) / 100);
    }
    const retentionCents = Math.round((subtotalCents * retentionPct) / 100);
    return {
        subtotalCents,
        taxCents,
        retentionCents,
        totalCents: subtotalCents + taxCents - retentionCents,
    };
}

function fmtEuros(cents: number): string {
    return `${(cents / 100).toFixed(2)} €`;
}
