"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useNotification } from "@/components/NotificationContext";

interface Tax {
    id: string;
    name: string;
    rate: number;
}

interface PurchaseLine {
    id: string;
    position: number;
    description: string;
    quantity: number;
    unitPriceCents: number;
    lineSubtotalCents: number;
    lineTaxCents: number;
    lineTotalCents: number;
    taxId: string | null;
    tax: Tax | null;
}

interface Provider {
    id: string;
    name: string;
    taxId: string | null;
    email: string | null;
}

interface PurchaseInvoice {
    id: string;
    providerId: string;
    providerInvoiceNumber: string | null;
    year: number | null;
    number: number | null;
    status: string;
    issueDate: string | null;
    dueDate: string | null;
    subtotalCents: number;
    taxCents: number;
    retentionRate: number;
    retentionCents: number;
    totalCents: number;
    paidCents: number;
    notes: string | null;
    provider: Provider;
    lines: PurchaseLine[];
    createdAt: string;
}

interface LineItem {
    key: string;
    description: string;
    quantity: string;
    unitPriceCents: string;
    taxId: string;
    taxRate: number;
}

const STATUS_LABELS: Record<string, { label: string; class: string }> = {
    DRAFT: { label: "Borrador", class: "badge-draft" },
    BOOKED: { label: "Contabilizada", class: "badge-info" },
    PAID: { label: "Pagada", class: "badge-success" },
};

function fmtDate(d: string | null) {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("es-ES");
}

function fmtCents(c: number) {
    return (c / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function docNumber(p: PurchaseInvoice) {
    if (p.number && p.year) return `FP-${p.year}-${String(p.number).padStart(4, "0")}`;
    return "Borrador";
}

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
    const qty = parseFloat(line.quantity) || 0;
    const unit = parseInt(line.unitPriceCents) || 0;
    const sub = Math.round(qty * unit);
    const tax = Math.round(sub * line.taxRate / 100);
    const total = sub + tax;

    return (
        <div className="line-row">
            <input
                className="line-input line-input-desc"
                placeholder="Descripción"
                value={line.description}
                onChange={(e) => updateLine(line.key, "description", e.target.value)}
            />
            <input
                className="line-input line-input-sm"
                type="number"
                placeholder="Ud."
                value={line.quantity}
                onChange={(e) => updateLine(line.key, "quantity", e.target.value)}
                min="0"
                step="1"
            />
            <input
                className="line-input line-input-sm"
                type="number"
                placeholder="Precio (cts)"
                value={line.unitPriceCents}
                onChange={(e) => updateLine(line.key, "unitPriceCents", e.target.value)}
                min="0"
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
            <span className="line-total">{(total / 100).toFixed(2)} €</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeLine(line.key)}>✕</button>
        </div>
    );
}

export default function PurchaseDetailPage() {
    const { id } = useParams();
    const router = useRouter();
    const { showError, showConfirm, showSuccess } = useNotification();
    const [purchase, setPurchase] = useState<PurchaseInvoice | null>(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);

    // Edit state
    const [taxes, setTaxes] = useState<Tax[]>([]);
    const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
    const [editProviderId, setEditProviderId] = useState("");
    const [editProviderInvoiceNumber, setEditProviderInvoiceNumber] = useState("");
    const [editIssueDate, setEditIssueDate] = useState("");
    const [editDueDate, setEditDueDate] = useState("");
    const [editNotes, setEditNotes] = useState("");
    const [editLines, setEditLines] = useState<LineItem[]>([]);
    // Edición segura (notas, vencimiento, nº proveedor) sobre facturas contabilizadas/pagadas
    const [showSafeEdit, setShowSafeEdit] = useState(false);
    const [safeNotes, setSafeNotes] = useState("");
    const [safeDueDate, setSafeDueDate] = useState("");
    const [safeProviderInvoiceNumber, setSafeProviderInvoiceNumber] = useState("");
    const [savingSafe, setSavingSafe] = useState(false);
    const [creatingRectifying, setCreatingRectifying] = useState(false);

    useEffect(() => {
        fetchPurchase();
    }, [id]);

    async function fetchPurchase() {
        try {
            const res = await fetch(`/api/purchases/${id}`);
            if (!res.ok) throw new Error("No encontrada");
            const data = await res.json();
            setPurchase(data);
        } catch {
            showError("Factura de proveedor no encontrada");
        } finally {
            setLoading(false);
        }
    }

    function startEditing() {
        if (!purchase) return;

        // Load taxes and providers for edit mode
        fetch("/api/taxes").then((r) => r.json()).then((d) => setTaxes(Array.isArray(d) ? d : []));
        fetch("/api/providers").then((r) => r.json()).then((d) => setProviders(Array.isArray(d) ? d : []));

        setEditProviderId(purchase.providerId);
        setEditProviderInvoiceNumber(purchase.providerInvoiceNumber || "");
        setEditIssueDate(purchase.issueDate ? purchase.issueDate.split("T")[0] : "");
        setEditDueDate(purchase.dueDate ? purchase.dueDate.split("T")[0] : "");
        setEditNotes(purchase.notes || "");
        setEditLines(purchase.lines.map((l) => ({
            key: crypto.randomUUID(),
            description: l.description,
            quantity: String(l.quantity),
            unitPriceCents: String(l.unitPriceCents),
            taxId: l.taxId || "",
            taxRate: l.tax?.rate || 0,
        })));
        setEditing(true);
    }

    function updateLine(key: string, field: string, value: string) {
        setEditLines((prev) =>
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
        setEditLines((prev) => prev.filter((l) => l.key !== key));
    }

    async function handleSave() {
        setSaving(true);

        try {
            const res = await fetch(`/api/purchases/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    providerId: editProviderId,
                    providerInvoiceNumber: editProviderInvoiceNumber || null,
                    issueDate: editIssueDate || null,
                    dueDate: editDueDate || null,
                    notes: editNotes || null,
                    lines: editLines.map((l) => ({
                        description: l.description,
                        quantity: l.quantity,
                        unitPriceCents: l.unitPriceCents,
                        taxId: l.taxId || null,
                        taxRate: l.taxRate,
                    })),
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Error al actualizar");
            }

            const updated = await res.json();
            setPurchase(updated);
            setEditing(false);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setSaving(false);
        }
    }

    async function handleBook() {
        if (!await showConfirm("¿Contabilizar esta factura? Se asignará un número y no podrá editarse.")) return;
        try {
            const res = await fetch(`/api/purchases/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "BOOKED" }),
            });
            if (res.ok) {
                const updated = await res.json();
                setPurchase(updated);
            }
        } catch { }
    }

    async function handlePay() {
        if (!await showConfirm("¿Marcar como pagada?")) return;
        try {
            const res = await fetch(`/api/purchases/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "PAID" }),
            });
            if (res.ok) {
                const updated = await res.json();
                setPurchase(updated);
            }
        } catch { }
    }

    async function handleDownloadPDF() {
        try {
            const res = await fetch(`/api/purchases/${id}/pdf`);
            if (!res.ok) throw new Error();
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `factura-proveedor-${id}.pdf`;
            a.click();
            URL.revokeObjectURL(url);
        } catch { }
    }

    async function handleDelete() {
        if (!await showConfirm("¿Eliminar esta factura de proveedor?")) return;
        try {
            const res = await fetch(`/api/purchases/${id}`, { method: "DELETE" });
            if (res.ok) router.push("/purchases");
        } catch (err: any) {
            showError(err.message);
        }
    }

    // ── Edición segura (notas + vencimiento + nº proveedor) ──
    function openSafeEditModal() {
        if (!purchase) return;
        setSafeNotes(purchase.notes || "");
        setSafeDueDate(
            purchase.dueDate
                ? new Date(purchase.dueDate).toISOString().slice(0, 10)
                : ""
        );
        setSafeProviderInvoiceNumber(purchase.providerInvoiceNumber || "");
        setShowSafeEdit(true);
    }

    async function handleSaveSafeEdit() {
        setSavingSafe(true);
        try {
            const res = await fetch(`/api/purchases/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    notes: safeNotes,
                    dueDate: safeDueDate || null,
                    providerInvoiceNumber: safeProviderInvoiceNumber || null,
                }),
            });
            if (!res.ok) throw new Error((await res.json()).error || "Error al guardar");
            const updated = await res.json();
            setPurchase(updated);
            showSuccess("Cambios guardados");
            setShowSafeEdit(false);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setSavingSafe(false);
        }
    }

    // ── Crear factura rectificativa de proveedor ───────────
    async function handleCreateRectifying() {
        if (!purchase) return;
        if (
            !(await showConfirm(
                "¿Crear una factura rectificativa de proveedor? Se creará un borrador con líneas en negativo apuntando a esta factura."
            ))
        )
            return;
        setCreatingRectifying(true);
        try {
            const rectifyLines = (purchase.lines || []).map((l: PurchaseLine) => ({
                description: l.description,
                quantity: -Math.abs(Number(l.quantity) || 0),
                unitPriceCents: l.unitPriceCents,
                taxId: l.taxId || null,
                taxRate: l.tax?.rate ?? 0,
            }));
            const res = await fetch("/api/purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    providerId: purchase.providerId,
                    rectifiesPurchaseInvoiceId: purchase.id,
                    notes: `Rectificativa de la factura ${purchase.number ?? ""}`.trim(),
                    lines: rectifyLines,
                }),
            });
            if (!res.ok) throw new Error((await res.json()).error || "Error al crear");
            const newP = await res.json();
            showSuccess("Rectificativa creada como borrador");
            router.push(`/purchases/${newP.id}`);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setCreatingRectifying(false);
        }
    }

    if (loading) {
        return (
            <div className="loading-center">
                <div className="spinner" />
            </div>
        );
    }

    if (!purchase) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">🔍</div>
                <h3>Factura de proveedor no encontrada</h3>
                <Link href="/purchases" className="btn btn-primary mt-4">
                    ← Volver a facturas
                </Link>
            </div>
        );
    }

    const st = STATUS_LABELS[purchase.status] || { label: purchase.status, class: "badge-draft" };

    // Edit mode totals
    const editSubtotalCents = editLines.reduce((sum, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const unit = parseInt(l.unitPriceCents) || 0;
        return sum + Math.round(qty * unit);
    }, 0);

    const editTaxCents = editLines.reduce((sum, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const unit = parseInt(l.unitPriceCents) || 0;
        const sub = Math.round(qty * unit);
        return sum + Math.round(sub * l.taxRate / 100);
    }, 0);

    const editTotalCents = editSubtotalCents + editTaxCents;

    return (
        <>
            <div className="page-header">
                <div>
                    <h1>{docNumber(purchase)}</h1>
                    <p className="page-header-sub">
                        <span className={`badge ${st.class}`}>{st.label}</span>
                        {" · "}
                        {purchase.provider?.name}
                        {purchase.providerInvoiceNumber && ` · Nº Proveedor: ${purchase.providerInvoiceNumber}`}
                    </p>
                </div>
                <div className="flex gap-2">
                    {!editing && (
                        <>
                            <button onClick={handleDownloadPDF} className="btn btn-secondary">
                                📄 PDF
                            </button>
                            {purchase.status === "DRAFT" && (
                                <>
                                    <button onClick={startEditing} className="btn btn-secondary">
                                        ✏️ Editar
                                    </button>
                                    <button onClick={handleBook} className="btn btn-primary">
                                        ✅ Contabilizar
                                    </button>
                                    <button onClick={handleDelete} className="btn btn-danger">
                                        🗑️ Eliminar
                                    </button>
                                </>
                            )}
                            {purchase.status === "BOOKED" && (
                                <>
                                    <button onClick={handlePay} className="btn btn-primary">
                                        💰 Marcar Pagada
                                    </button>
                                    <button onClick={openSafeEditModal} className="btn btn-secondary">
                                        ✏️ Editar
                                    </button>
                                    <button
                                        onClick={handleCreateRectifying}
                                        className="btn btn-secondary"
                                        disabled={creatingRectifying}
                                    >
                                        {creatingRectifying ? "Creando..." : "↩ Rectificativa"}
                                    </button>
                                </>
                            )}
                            {purchase.status === "PAID" && (
                                <>
                                    <button onClick={openSafeEditModal} className="btn btn-secondary">
                                        ✏️ Editar
                                    </button>
                                    <button
                                        onClick={handleCreateRectifying}
                                        className="btn btn-secondary"
                                        disabled={creatingRectifying}
                                    >
                                        {creatingRectifying ? "Creando..." : "↩ Rectificativa"}
                                    </button>
                                </>
                            )}
                        </>
                    )}
                    <Link href="/purchases" className="btn btn-ghost">
                        ← Volver
                    </Link>
                </div>
            </div>



            {editing ? (
                /* Edit Mode */
                <>
                    <div className="card" style={{ marginBottom: 20 }}>
                        <div className="card-body">
                            <div className="form-row">
                                <div className="form-group" style={{ flex: 2 }}>
                                    <label className="form-label">Proveedor *</label>
                                    <select
                                        className="form-input"
                                        value={editProviderId}
                                        onChange={(e) => setEditProviderId(e.target.value)}
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
                                        value={editProviderInvoiceNumber}
                                        onChange={(e) => setEditProviderInvoiceNumber(e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label className="form-label">Fecha Factura</label>
                                    <input
                                        type="date"
                                        className="form-input"
                                        value={editIssueDate}
                                        onChange={(e) => setEditIssueDate(e.target.value)}
                                    />
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Fecha Vencimiento</label>
                                    <input
                                        type="date"
                                        className="form-input"
                                        value={editDueDate}
                                        onChange={(e) => setEditDueDate(e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="card" style={{ marginBottom: 20 }}>
                        <div className="card-header">
                            <h3 style={{ margin: 0 }}>Líneas</h3>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => setEditLines([...editLines, {
                                    key: crypto.randomUUID(),
                                    description: "",
                                    quantity: "1",
                                    unitPriceCents: "0",
                                    taxId: "",
                                    taxRate: 0,
                                }])}
                            >
                                + Añadir línea
                            </button>
                        </div>
                        <div className="card-body" style={{ padding: 0 }}>
                            <div className="lines-header">
                                <span className="line-input-desc">Descripción</span>
                                <span className="line-input-sm">Uds</span>
                                <span className="line-input-sm">Precio (cts)</span>
                                <span>IVA</span>
                                <span className="line-total">Total</span>
                                <span style={{ width: 30 }}></span>
                            </div>
                            {editLines.map((line) => (
                                <LineItemEditor
                                    key={line.key}
                                    line={line}
                                    taxes={taxes}
                                    updateLine={updateLine}
                                    removeLine={removeLine}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="card" style={{ marginBottom: 20 }}>
                        <div className="card-body">
                            <div className="totals-grid">
                                <div className="totals-row">
                                    <span>Base imponible</span>
                                    <span className="cell-mono">{(editSubtotalCents / 100).toFixed(2)} €</span>
                                </div>
                                <div className="totals-row">
                                    <span>IVA</span>
                                    <span className="cell-mono">{(editTaxCents / 100).toFixed(2)} €</span>
                                </div>
                                <div className="totals-row totals-total">
                                    <span>Total</span>
                                    <span className="cell-mono">{(editTotalCents / 100).toFixed(2)} €</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="card" style={{ marginBottom: 20 }}>
                        <div className="card-body">
                            <div className="form-group">
                                <label className="form-label">Notas internas</label>
                                <textarea
                                    className="form-textarea"
                                    value={editNotes}
                                    onChange={(e) => setEditNotes(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="form-actions">
                        <button className="btn btn-primary btn-lg" onClick={handleSave} disabled={saving}>
                            {saving ? "Guardando..." : "Guardar cambios"}
                        </button>
                        <button className="btn btn-secondary" onClick={() => setEditing(false)}>
                            Cancelar
                        </button>
                    </div>
                </>
            ) : (
                /* Read-only Mode */
                <>
                    <div className="card" style={{ marginBottom: 20 }}>
                        <div className="card-body">
                            <div className="form-row">
                                <div className="form-group">
                                    <label className="form-label">Proveedor</label>
                                    <p style={{ fontSize: 14 }}>{purchase.provider?.name}</p>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">NIF</label>
                                    <p style={{ fontSize: 14, fontFamily: "var(--font-mono)" }}>
                                        {purchase.provider?.taxId || "—"}
                                    </p>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Nº Factura Proveedor</label>
                                    <p style={{ fontSize: 14, fontFamily: "var(--font-mono)" }}>
                                        {purchase.providerInvoiceNumber || "—"}
                                    </p>
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label className="form-label">Fecha</label>
                                    <p style={{ fontSize: 14 }}>{fmtDate(purchase.issueDate)}</p>
                                </div>
                                <div className="form-group">
                                    <label className="form-label">Vencimiento</label>
                                    <p style={{ fontSize: 14 }}>{fmtDate(purchase.dueDate)}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Lines table */}
                    <div className="card" style={{ marginBottom: 20 }}>
                        <div className="card-header">
                            <h3 style={{ margin: 0 }}>Líneas</h3>
                        </div>
                        <div className="card-body" style={{ padding: 0 }}>
                            <table className="data-table" style={{ marginBottom: 0 }}>
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Descripción</th>
                                        <th className="text-right">Precio</th>
                                        <th className="text-right">Uds</th>
                                        <th className="text-right">Subtotal</th>
                                        <th className="text-right">IVA</th>
                                        <th className="text-right">Total</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {purchase.lines.map((line) => (
                                        <tr key={line.id}>
                                            <td>{line.position}</td>
                                            <td>{line.description}</td>
                                            <td className="text-right cell-mono">{fmtCents(line.unitPriceCents)}</td>
                                            <td className="text-right">{line.quantity}</td>
                                            <td className="text-right cell-mono">{fmtCents(line.lineSubtotalCents)}</td>
                                            <td className="text-right">{line.tax ? `${line.tax.rate}%` : "—"}</td>
                                            <td className="text-right cell-mono">{fmtCents(line.lineTotalCents)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Totals */}
                    <div className="card" style={{ marginBottom: 20 }}>
                        <div className="card-body">
                            <div className="totals-grid">
                                <div className="totals-row">
                                    <span>Base imponible</span>
                                    <span className="cell-mono">{fmtCents(purchase.subtotalCents)}</span>
                                </div>
                                <div className="totals-row">
                                    <span>IVA</span>
                                    <span className="cell-mono" style={{ color: 'var(--color-success, #22c55e)' }}>+{fmtCents(purchase.taxCents)}</span>
                                </div>
                                {purchase.retentionCents > 0 && (
                                    <div className="totals-row">
                                        <span>Retención IRPF ({Number(purchase.retentionRate)}%)</span>
                                        <span className="cell-mono" style={{ color: 'var(--color-error, #ef4444)' }}>-{fmtCents(purchase.retentionCents)}</span>
                                    </div>
                                )}
                                <div className="totals-row totals-total">
                                    <span>Total</span>
                                    <span className="cell-mono">{fmtCents(purchase.totalCents)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Notes */}
                    {purchase.notes && (
                        <div className="card">
                            <div className="card-body">
                                <label className="form-label">Notas internas</label>
                                <p style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{purchase.notes}</p>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Modal: edición segura sobre facturas contabilizadas / pagadas */}
            {showSafeEdit && (
                <div className="modal-overlay" onClick={() => setShowSafeEdit(false)}>
                    <div
                        className="modal-content"
                        onClick={(e) => e.stopPropagation()}
                        style={{ maxWidth: 580 }}
                    >
                        <div className="modal-header">
                            <h2 className="modal-title">Editar campos seguros</h2>
                            <button className="btn-close" onClick={() => setShowSafeEdit(false)}>
                                ✕
                            </button>
                        </div>
                        <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
                            <p style={{ fontSize: 12.5, color: "var(--color-text-muted)", marginBottom: 16 }}>
                                Una factura contabilizada no puede cambiar líneas, importes ni fecha
                                de emisión. Para correcciones en esos campos usa{" "}
                                <strong>Rectificativa</strong>. Aquí solo puedes ajustar campos no
                                contables.
                            </p>
                            <div className="form-group">
                                <label className="form-label">Nº factura proveedor</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    value={safeProviderInvoiceNumber}
                                    onChange={(e) => setSafeProviderInvoiceNumber(e.target.value)}
                                    placeholder="Ej: FA-2026-001"
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">Fecha de vencimiento</label>
                                <input
                                    type="date"
                                    className="form-input"
                                    value={safeDueDate}
                                    onChange={(e) => setSafeDueDate(e.target.value)}
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label">Notas internas</label>
                                <textarea
                                    className="form-textarea"
                                    rows={4}
                                    value={safeNotes}
                                    onChange={(e) => setSafeNotes(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => setShowSafeEdit(false)}
                                disabled={savingSafe}
                            >
                                Cancelar
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={handleSaveSafeEdit}
                                disabled={savingSafe}
                            >
                                {savingSafe ? "Guardando..." : "Guardar"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
