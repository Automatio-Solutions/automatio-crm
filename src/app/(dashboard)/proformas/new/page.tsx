"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
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
        key: crypto.randomUUID(),
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
    const taxCents = Math.round(subtotalCents * line.taxRate / 100);
    const totalCents = subtotalCents + taxCents;
    return { subtotalCents, taxCents, totalCents, unitCents };
}

function formatCents(cents: number): string {
    return (cents / 100).toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

export default function NewProformaPage() {
    const router = useRouter();
    const { showError } = useNotification();
    const [clients, setClients] = useState<Client[]>([]);
    const [taxes, setTaxes] = useState<Tax[]>([]);
    const [clientId, setClientId] = useState("");
    const [issueDate, setIssueDate] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [notes, setNotes] = useState("");
    const [publicNotes, setPublicNotes] = useState("");
    const [lines, setLines] = useState<LineItem[]>([emptyLine()]);
    const [saving, setSaving] = useState(false);
    const [showClientModal, setShowClientModal] = useState(false);

    useEffect(() => {
        Promise.all([
            fetch("/api/clients").then((r) => r.json()),
            fetch("/api/taxes").then((r) => r.json()),
        ]).then(([c, t]) => {
            setClients(Array.isArray(c) ? c : []);
            const taxList = Array.isArray(t) ? t : [];
            setTaxes(taxList);
            const defaultTax = taxList.find((tx: Tax) => tx.name.includes("21"));
            if (defaultTax) {
                setLines((prev) =>
                    prev.map((l) =>
                        !l.taxId ? { ...l, taxId: defaultTax.id, taxRate: Number(defaultTax.rate) } : l
                    )
                );
            }
        });
    }, []);

    const updateLine = useCallback((key: string, field: string, value: string) => {
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
    }, [taxes]);

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
            const res = await fetch("/api/proformas", {
                method: "POST",
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
                throw new Error(err.error || "Error al crear proforma");
            }

            const proforma = await res.json();
            router.push(`/invoices/${proforma.id}`);
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
                    <h1>Nueva Factura Proforma</h1>
                    <p className="page-header-sub">Crea una proforma para enviar al cliente antes de facturar</p>
                </div>
                <Link href="/proformas" className="btn btn-secondary">
                    ← Volver
                </Link>
            </div>

            {/* Header fields */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header">
                    <span className="card-title">Datos de la proforma</span>
                    <span className="badge badge-draft">Borrador</span>
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
                                    style={{ padding: '0 4px', fontSize: '11.5px', color: 'var(--color-primary)' }}
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
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Fecha proforma</label>
                            <input
                                type="date"
                                className="form-input"
                                value={issueDate}
                                onChange={(e) => setIssueDate(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label className="form-label">Válido hasta</label>
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
                        {/* Header */}
                        <div className="line-row line-row-header">
                            <span>Concepto</span>
                            <span>Descripción</span>
                            <span>Cantidad</span>
                            <span>Precio (€)</span>
                            <span>Impuesto</span>
                            <span>Total</span>
                            <span></span>
                        </div>

                        {/* Lines */}
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
                                                        ? { ...l, description: svc.description, unitPriceEuros: svc.unitPriceEuros, taxId: svc.taxId, taxRate: svc.taxRate }
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
                                            <option key={t.id} value={t.id}>{t.name}</option>
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
                                <p className="text-muted">Añade líneas a la proforma</p>
                            </div>
                        )}
                    </div>

                    {/* Totals */}
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
                                placeholder="Se mostrarán en la proforma..."
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
                    {saving ? "Guardando..." : "💾 Guardar Proforma"}
                </button>
                <Link href="/proformas" className="btn btn-secondary btn-lg">
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
