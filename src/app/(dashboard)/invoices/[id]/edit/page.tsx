"use client";

// ============================================================
// Edit page for an existing invoice (cualquier estado).
// Estructura idéntica a /invoices/new pero:
//  - Carga datos del PUT /api/invoices/[id]
//  - Pre-rellena el form
//  - Guarda con PUT en vez de POST
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useNotification } from "@/components/NotificationContext";
import ServiceAutocomplete from "@/components/ServiceAutocomplete";
import ClientModal from "@/components/ClientModal";

interface Tax {
    id: string;
    name: string;
    rate: number;
}

interface Client {
    id: string;
    name: string;
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

function emptyLine(): LineItem {
    return {
        key:
            typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2),
        description: "",
        details: "",
        quantity: "1",
        unitPriceEuros: "",
        taxId: "",
        taxRate: 0,
    };
}

function calcLine(line: LineItem) {
    const qty = parseFloat(line.quantity) || 0;
    const unitCents = Math.round((parseFloat(line.unitPriceEuros) || 0) * 100);
    const subtotalCents = Math.round(qty * unitCents);
    const taxCents = Math.round((subtotalCents * line.taxRate) / 100);
    const totalCents = subtotalCents + taxCents;
    return { subtotalCents, taxCents, totalCents, unitCents };
}

function formatCents(cents: number): string {
    return (cents / 100).toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

export default function EditInvoicePage() {
    const { id } = useParams();
    const router = useRouter();
    const { showError, showSuccess } = useNotification();

    const [clients, setClients] = useState<Client[]>([]);
    const [taxes, setTaxes] = useState<Tax[]>([]);
    const [loading, setLoading] = useState(true);
    const [invoiceMeta, setInvoiceMeta] = useState<{
        number: string | null;
        status: string;
        type: string;
        paidCents: number;
    } | null>(null);

    const [clientId, setClientId] = useState("");
    const [issueDate, setIssueDate] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [notes, setNotes] = useState("");
    const [publicNotes, setPublicNotes] = useState("");
    const [lines, setLines] = useState<LineItem[]>([]);
    const [saving, setSaving] = useState(false);
    const [showClientModal, setShowClientModal] = useState(false);

    // ── Carga inicial: clients, taxes, invoice ──────────
    useEffect(() => {
        Promise.all([
            fetch("/api/clients").then((r) => r.json()),
            fetch("/api/taxes").then((r) => r.json()),
            fetch(`/api/invoices/${id}`).then((r) => r.json()),
        ])
            .then(([c, t, inv]) => {
                setClients(Array.isArray(c) ? c : []);
                const taxList: Tax[] = Array.isArray(t) ? t : [];
                setTaxes(taxList);

                if (inv && !inv.error) {
                    setInvoiceMeta({
                        number: inv.number ?? null,
                        status: inv.status,
                        type: inv.type,
                        paidCents: inv.paidCents || 0,
                    });
                    setClientId(inv.clientId || inv.client?.id || "");
                    setIssueDate(
                        inv.issueDate ? new Date(inv.issueDate).toISOString().slice(0, 10) : ""
                    );
                    setDueDate(
                        inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : ""
                    );
                    setNotes(inv.notes || "");
                    setPublicNotes(inv.publicNotes || "");

                    const mappedLines: LineItem[] = (inv.lines || []).map((l: {
                        description: string;
                        details: string | null;
                        quantity: number | string;
                        unitPriceCents: number;
                        taxId: string | null;
                        tax: { rate: number | string } | null;
                    }) => ({
                        key:
                            typeof crypto !== "undefined" && crypto.randomUUID
                                ? crypto.randomUUID()
                                : Math.random().toString(36).slice(2),
                        description: l.description || "",
                        details: l.details || "",
                        quantity: String(l.quantity || ""),
                        unitPriceEuros: ((l.unitPriceCents || 0) / 100).toFixed(2),
                        taxId: l.taxId || "",
                        taxRate: l.tax?.rate ? Number(l.tax.rate) : 0,
                    }));
                    setLines(mappedLines.length > 0 ? mappedLines : [emptyLine()]);
                } else {
                    showError(inv?.error || "Factura no encontrada");
                }
            })
            .catch((e) => showError(e?.message || "Error al cargar"))
            .finally(() => setLoading(false));
    }, [id, showError]);

    const updateLine = useCallback(
        (key: string, field: string, value: string) => {
            setLines((prev) =>
                prev.map((l) => {
                    if (l.key !== key) return l;
                    if (field === "taxId") {
                        const tax = taxes.find((t) => t.id === value);
                        return { ...l, taxId: value, taxRate: tax ? Number(tax.rate) : 0 };
                    }
                    return { ...l, [field]: value };
                })
            );
        },
        [taxes]
    );

    const addLine = () => {
        const defaultTax = taxes.find((t) => t.name.includes("21"));
        setLines((prev) => [
            ...prev,
            {
                ...emptyLine(),
                taxId: defaultTax?.id || "",
                taxRate: defaultTax ? Number(defaultTax.rate) : 0,
            },
        ]);
    };

    const removeLine = (key: string) => {
        setLines((prev) => prev.filter((l) => l.key !== key));
    };

    // Totals
    const lineCalcs = lines.map(calcLine);
    const subtotalCents = lineCalcs.reduce((s, l) => s + l.subtotalCents, 0);
    const taxCents = lineCalcs.reduce((s, l) => s + l.taxCents, 0);
    const totalCents = subtotalCents + taxCents;

    async function handleSave() {
        if (!clientId) {
            showError("Selecciona un cliente");
            return;
        }
        if (lines.length === 0 || lines.every((l) => !l.description)) {
            showError("Añade al menos una línea con descripción");
            return;
        }

        setSaving(true);
        const apiLines = lines
            .filter((l) => l.description)
            .map((l) => {
                const c = calcLine(l);
                return {
                    description: l.description,
                    details: l.details || null,
                    quantity: parseFloat(l.quantity) || 0,
                    unitPriceCents: c.unitCents,
                    taxId: l.taxId || null,
                    taxRate: l.taxRate,
                };
            });

        try {
            const res = await fetch(`/api/invoices/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    clientId,
                    notes,
                    publicNotes,
                    issueDate: issueDate || null,
                    dueDate: dueDate || null,
                    lines: apiLines,
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Error al guardar");
            }

            showSuccess("Factura actualizada");
            router.push(`/invoices/${id}`);
        } catch (err) {
            showError(err instanceof Error ? err.message : "Error al guardar");
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <div className="loading-center">
                <div className="spinner" />
            </div>
        );
    }

    if (!invoiceMeta) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">🔍</div>
                <h3>Factura no encontrada</h3>
                <Link href="/invoices" className="btn btn-primary mt-4">
                    ← Volver
                </Link>
            </div>
        );
    }

    const statusBadgeClass: Record<string, string> = {
        DRAFT: "badge-draft",
        ISSUED: "badge-info",
        PARTIALLY_PAID: "badge-warning",
        PAID: "badge-success",
        VOID: "badge-danger",
    };
    const statusLabel: Record<string, string> = {
        DRAFT: "Borrador",
        ISSUED: "Emitida",
        PARTIALLY_PAID: "Parcial",
        PAID: "Pagada",
        VOID: "Anulada",
    };

    return (
        <>
            <div className="page-header">
                <div>
                    <h1>{invoiceMeta.number ? `Editar ${invoiceMeta.number}` : "Editar borrador"}</h1>
                    <p className="page-header-sub">
                        <span className={`badge ${statusBadgeClass[invoiceMeta.status] || "badge-draft"}`}>
                            {statusLabel[invoiceMeta.status] || invoiceMeta.status}
                        </span>
                        {invoiceMeta.status !== "DRAFT" && (
                            <span style={{ marginLeft: 10, color: "var(--color-warning)", fontSize: 12.5 }}>
                                ⚠ Estás editando una factura ya emitida. Considera usar una rectificativa.
                            </span>
                        )}
                    </p>
                </div>
                <Link href={`/invoices/${id}`} className="btn btn-secondary">
                    ← Volver
                </Link>
            </div>

            {/* Header fields */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header">
                    <span className="card-title">Datos de la factura</span>
                </div>
                <div className="card-body">
                    <div className="form-row">
                        <div className="form-group">
                            <div className="flex justify-between items-center mb-1">
                                <label className="form-label" style={{ marginBottom: 0 }}>Cliente *</label>
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => setShowClientModal(true)}
                                    style={{ padding: "0 4px", fontSize: "11.5px", color: "var(--color-primary)" }}
                                >
                                    + Nuevo Cliente
                                </button>
                            </div>
                            <select
                                className="form-select"
                                value={clientId}
                                onChange={(e) => setClientId(e.target.value)}
                            >
                                <option value="">Seleccionar cliente...</option>
                                {clients.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Fecha factura</label>
                            <input
                                type="date"
                                className="form-input"
                                value={issueDate}
                                onChange={(e) => setIssueDate(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label className="form-label">Fecha vencimiento</label>
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

            {/* Line Editor */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header">
                    <span className="card-title">Líneas de detalle</span>
                    <button className="btn btn-primary btn-sm" onClick={addLine}>
                        + Añadir línea
                    </button>
                </div>
                <div className="card-body">
                    <div className="lines-editor">
                        <div className="line-row line-row-header">
                            <span>Concepto</span>
                            <span>Descripción</span>
                            <span>Cantidad</span>
                            <span>Precio (€)</span>
                            <span>Impuesto</span>
                            <span>Total</span>
                            <span></span>
                        </div>
                        {lines.map((line) => {
                            const c = calcLine(line);
                            return (
                                <div className="line-row" key={line.key}>
                                    <ServiceAutocomplete
                                        value={line.description}
                                        onChange={(val) => updateLine(line.key, "description", val)}
                                        onServiceSelect={(svc) => {
                                            setLines((prev) =>
                                                prev.map((l) =>
                                                    l.key === line.key
                                                        ? {
                                                            ...l,
                                                            description: svc.description,
                                                            unitPriceEuros: svc.unitPriceEuros,
                                                            taxId: svc.taxId,
                                                            taxRate: svc.taxRate,
                                                        }
                                                        : l
                                                )
                                            );
                                        }}
                                        placeholder="Escribe el concepto o usa @ para buscar..."
                                    />
                                    <textarea
                                        className="line-input line-details"
                                        placeholder="Desc"
                                        value={line.details}
                                        onChange={(e) => updateLine(line.key, "details", e.target.value)}
                                        rows={1}
                                    />
                                    <input
                                        className="line-input"
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={line.quantity}
                                        onChange={(e) => updateLine(line.key, "quantity", e.target.value)}
                                    />
                                    <input
                                        className="line-input"
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        placeholder="0,00"
                                        value={line.unitPriceEuros}
                                        onChange={(e) => updateLine(line.key, "unitPriceEuros", e.target.value)}
                                    />
                                    <select
                                        className="line-input"
                                        value={line.taxId}
                                        onChange={(e) => updateLine(line.key, "taxId", e.target.value)}
                                    >
                                        <option value="">Sin IVA</option>
                                        {taxes.map((t) => (
                                            <option key={t.id} value={t.id}>
                                                {t.name}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="line-computed" style={{ fontWeight: 600, color: "var(--color-text)" }}>
                                        {formatCents(c.totalCents)}
                                    </span>
                                    <button
                                        className="line-delete-btn"
                                        onClick={() => removeLine(line.key)}
                                        title="Eliminar línea"
                                    >
                                        ✕
                                    </button>
                                </div>
                            );
                        })}
                        {lines.length === 0 && (
                            <div className="empty-state" style={{ padding: 30 }}>
                                <p className="text-muted">Añade líneas a la factura</p>
                            </div>
                        )}
                    </div>

                    <div className="lines-footer">
                        <button className="btn btn-secondary btn-sm" onClick={addLine}>
                            + Añadir línea
                        </button>
                        <div className="lines-totals">
                            <div className="lines-totals-row">
                                <span className="lines-totals-label">Subtotal</span>
                                <span className="lines-totals-value">{formatCents(subtotalCents)} €</span>
                            </div>
                            <div className="lines-totals-row">
                                <span className="lines-totals-label">Impuestos</span>
                                <span className="lines-totals-value">{formatCents(taxCents)} €</span>
                            </div>
                            <div className="lines-totals-row total">
                                <span className="lines-totals-label">Total</span>
                                <span className="lines-totals-value">{formatCents(totalCents)} €</span>
                            </div>
                            {invoiceMeta.paidCents > 0 && (
                                <div
                                    className="lines-totals-row"
                                    style={{
                                        fontSize: 11.5,
                                        color: "var(--color-text-muted)",
                                        marginTop: 6,
                                    }}
                                >
                                    <span className="lines-totals-label">Pagado</span>
                                    <span className="lines-totals-value">
                                        {formatCents(invoiceMeta.paidCents)} €
                                        {invoiceMeta.paidCents > totalCents && (
                                            <span style={{ color: "var(--color-warning)", marginLeft: 6 }}>
                                                · se ajustará al nuevo total
                                            </span>
                                        )}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Notes */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-body">
                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Notas internas</label>
                            <textarea
                                className="form-textarea"
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                placeholder="Solo visibles internamente..."
                            />
                        </div>
                        <div className="form-group">
                            <label className="form-label">Notas visibles (PDF)</label>
                            <textarea
                                className="form-textarea"
                                value={publicNotes}
                                onChange={(e) => setPublicNotes(e.target.value)}
                                placeholder="Se mostrarán en la factura..."
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
                <button
                    className="btn btn-primary btn-lg"
                    onClick={handleSave}
                    disabled={saving}
                >
                    {saving ? "Guardando..." : "💾 Guardar cambios"}
                </button>
                <Link href={`/invoices/${id}`} className="btn btn-secondary btn-lg">
                    Cancelar
                </Link>
            </div>

            <ClientModal
                isOpen={showClientModal}
                onClose={() => setShowClientModal(false)}
                onSuccess={(client) => {
                    setClients((prev) => [...prev, client]);
                    setClientId(client.id);
                }}
            />
        </>
    );
}
