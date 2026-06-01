"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useNotification } from "@/components/NotificationContext";

function formatCents(cents: number): string {
    return (cents / 100).toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

const STATUS_LABELS: Record<string, { label: string; class: string }> = {
    DRAFT: { label: "Borrador", class: "badge-draft" },
    ISSUED: { label: "Emitida", class: "badge-info" },
    PARTIALLY_PAID: { label: "Parcial", class: "badge-warning" },
    PAID: { label: "Pagada", class: "badge-success" },
    VOID: { label: "Anulada", class: "badge-danger" },
};

export default function InvoiceDetailPage() {
    const { id } = useParams();
    const router = useRouter();
    const { showSuccess, showError, showConfirm } = useNotification();
    const [invoice, setInvoice] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState("");
    const [documents, setDocuments] = useState<any[]>([]);
    const [uploading, setUploading] = useState(false);
    const [showPartialModal, setShowPartialModal] = useState(false);
    const [partialAmount, setPartialAmount] = useState("");

    useEffect(() => {
        fetch(`/api/invoices/${id}`)
            .then((r) => r.json())
            .then((data) => {
                setInvoice(data);
                // Fetch documents after loading invoice
                fetch(`/api/documents/upload?entityType=INVOICE&entityId=${id}`)
                    .then((r) => r.json())
                    .then((docs) => { if (Array.isArray(docs)) setDocuments(docs); })
                    .catch(console.error);
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, [id]);

    // ── ACTION HANDLERS ─────────────────────────────────

    async function handleEmit() {
        const isProforma = invoice?.type === "PROFORMA";
        const label = isProforma ? "proforma" : "factura";
        if (!await showConfirm(`¿Emitir ${label}? Se asignará número definitivo.`)) return;
        setActionLoading("emit");
        try {
            const endpoint = isProforma
                ? `/api/proformas/${id}/emit`
                : `/api/invoices/${id}/emit`;
            const res = await fetch(endpoint, { method: "POST" });
            if (!res.ok) throw new Error((await res.json()).error);
            const updated = await res.json();
            setInvoice(updated);
            showSuccess(`${isProforma ? 'Proforma' : 'Factura'} emitida correctamente`);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
        }
    }

    async function handleConvertToInvoice() {
        if (!await showConfirm("¿Convertir esta proforma en factura? Se creará una nueva factura borrador con los mismos datos.")) return;
        setActionLoading("convert");
        try {
            const res = await fetch(`/api/proformas/${id}/convert`, { method: "POST" });
            if (!res.ok) throw new Error((await res.json()).error);
            const newInvoice = await res.json();
            showSuccess("Factura creada desde proforma");
            router.push(`/invoices/${newInvoice.id}`);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
        }
    }

    async function handleDownloadPDF() {
        setActionLoading("pdf");
        try {
            const res = await fetch(`/api/invoices/${id}/pdf`);
            if (!res.ok) throw new Error("Error al generar PDF");
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = res.headers.get("Content-Disposition")?.split("filename=")[1]?.replace(/"/g, "") || "factura.pdf";
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
        }
    }

    async function handleSendEmail() {
        if (!await showConfirm("¿Enviar factura por email al cliente?")) return;
        setActionLoading("send");
        try {
            const res = await fetch(`/api/invoices/${id}/send`, { method: "POST" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            showSuccess(`Enviado a ${data.sentTo}`);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
        }
    }

    async function handleMarkPaid() {
        if (!await showConfirm("¿Marcar esta factura como cobrada?")) return;
        setActionLoading("paid");
        try {
            const res = await fetch(`/api/invoices/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "PAID" }),
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const updated = await res.json();
            setInvoice(updated);
            showSuccess("Factura marcada como cobrada");
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
        }
    }

    async function handlePartialPayment() {
        const cents = Math.round(parseFloat(partialAmount) * 100);
        if (isNaN(cents) || cents <= 0) {
            showError("Introduce un importe válido");
            return;
        }
        setActionLoading("partial");
        try {
            const res = await fetch(`/api/invoices/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "PARTIALLY_PAID", paidCents: cents }),
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const updated = await res.json();
            setInvoice(updated);
            showSuccess("Cobro parcial registrado");
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
            setShowPartialModal(false);
            setPartialAmount("");
        }
    }

    async function handleVoid() {
        if (!await showConfirm("¿Anular esta factura? Esta acción no se puede deshacer.")) return;
        setActionLoading("void");
        try {
            const res = await fetch(`/api/invoices/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "VOID" }),
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const updated = await res.json();
            setInvoice(updated);
            showSuccess("Factura anulada");
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
        }
    }

    async function handleDelete() {
        if (!await showConfirm("¿Eliminar esta factura?")) return;
        try {
            const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Error al eliminar");
            router.push("/invoices");
        } catch (err: any) {
            showError(err.message);
        }
    }

    // ── Crear factura rectificativa ───────────────────────
    async function handleCreateRectifying() {
        if (!await showConfirm(
            "¿Crear una factura rectificativa? Se creará un borrador con líneas en negativo apuntando a esta factura. Luego podrás ajustarla y emitirla."
        )) return;
        setActionLoading("rectify");
        try {
            // Las líneas de la rectificativa son las originales con cantidad negada
            const rectifyLines = (invoice.lines || []).map((l: any) => ({
                description: l.description,
                details: l.details || null,
                quantity: -Math.abs(parseFloat(l.quantity) || 0),
                unitPriceCents: l.unitPriceCents,
                taxId: l.taxId || null,
                taxRate: l.tax?.rate ?? 0,
            }));
            const res = await fetch("/api/invoices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    clientId: invoice.client?.id || invoice.clientId,
                    rectifiesInvoiceId: invoice.id,
                    publicNotes: `Rectificativa de la factura ${invoice.number || ""}`.trim(),
                    lines: rectifyLines,
                }),
            });
            if (!res.ok) throw new Error((await res.json()).error);
            const newInv = await res.json();
            showSuccess("Rectificativa creada como borrador");
            router.push(`/invoices/${newInv.id}`);
        } catch (err: any) {
            showError(err.message);
        } finally {
            setActionLoading("");
        }
    }

    if (loading) {
        return <div className="loading-center"><div className="spinner" /></div>;
    }

    if (!invoice || invoice.error) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">🔍</div>
                <h3>Factura no encontrada</h3>
                <Link href="/invoices" className="btn btn-primary mt-4">← Volver</Link>
            </div>
        );
    }

    const isProforma = invoice.type === "PROFORMA";
    const st = STATUS_LABELS[invoice.status] || { label: invoice.status, class: "badge-draft" };
    const isDraft = invoice.status === "DRAFT";
    const isIssued = invoice.status === "ISSUED";
    const isPartiallyPaid = invoice.status === "PARTIALLY_PAID";
    const hasNumber = !!invoice.number;
    const canMarkPaid = !isProforma && (isIssued || isPartiallyPaid);
    const docTypeLabel = isProforma ? "Proforma" : invoice.type === "CREDIT_NOTE" ? "Rectificativa" : "Factura";

    const formatEur = (cents: number) => (cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

    return (
        <>
            <div className="page-header">
                <div>
                    <h1>
                        {invoice.number || `${docTypeLabel} (Borrador)`}
                    </h1>
                    <p className="page-header-sub">
                        <span className={`badge ${st.class}`}>{st.label}</span>
                        {" · "}
                        {invoice.client?.name}
                        {isProforma && (
                            <span className="badge badge-info" style={{ marginLeft: 8 }}>Proforma</span>
                        )}
                        {invoice.type === "CREDIT_NOTE" && (
                            <span className="badge badge-warning" style={{ marginLeft: 8 }}>Rectificativa</span>
                        )}
                    </p>
                </div>
                <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                    {/* DRAFT actions */}
                    {isDraft && (
                        <>
                            <button onClick={handleEmit} className="btn btn-primary" disabled={!!actionLoading}>
                                {actionLoading === "emit" ? "Emitiendo..." : "📋 Emitir"}
                            </button>
                            <Link href={`/invoices/${id}/edit`} className="btn btn-secondary">
                                ✏️ Editar
                            </Link>
                            <button onClick={handleDownloadPDF} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "pdf" ? "Generando..." : "📄 PDF"}
                            </button>
                            <button onClick={handleDelete} className="btn btn-danger btn-sm">🗑️</button>
                        </>
                    )}
                    {/* ISSUED + PROFORMA: convert to invoice */}
                    {isIssued && isProforma && (
                        <>
                            <button onClick={handleConvertToInvoice} className="btn btn-primary" disabled={!!actionLoading}>
                                {actionLoading === "convert" ? "Convirtiendo..." : "📄 Convertir a Factura"}
                            </button>
                            <button onClick={handleDownloadPDF} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "pdf" ? "Generando..." : "📄 PDF"}
                            </button>
                            <button onClick={handleSendEmail} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "send" ? "Enviando..." : "📧 Enviar"}
                            </button>
                        </>
                    )}
                    {/* ISSUED + regular invoice actions */}
                    {isIssued && !isProforma && (
                        <>
                            <button onClick={handleMarkPaid} className="btn btn-primary" disabled={!!actionLoading}>
                                {actionLoading === "paid" ? "Procesando..." : "💰 Marcar Cobrada"}
                            </button>
                            <button onClick={() => setShowPartialModal(true)} className="btn btn-secondary" disabled={!!actionLoading}>
                                💳 Cobro Parcial
                            </button>
                            <button onClick={handleDownloadPDF} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "pdf" ? "Generando..." : "📄 PDF"}
                            </button>
                            <button onClick={handleSendEmail} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "send" ? "Enviando..." : "📧 Enviar"}
                            </button>
                            <Link href={`/invoices/${id}/edit`} className="btn btn-secondary">
                                ✏️ Editar
                            </Link>
                            <button onClick={handleCreateRectifying} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "rectify" ? "Creando..." : "↩ Rectificativa"}
                            </button>
                            <button onClick={handleVoid} className="btn btn-danger btn-sm" disabled={!!actionLoading}>
                                🚫 Anular
                            </button>
                        </>
                    )}
                    {/* PARTIALLY_PAID actions */}
                    {isPartiallyPaid && !isProforma && (
                        <>
                            <button onClick={handleMarkPaid} className="btn btn-primary" disabled={!!actionLoading}>
                                {actionLoading === "paid" ? "Procesando..." : "💰 Cobrar Resto"}
                            </button>
                            <button onClick={handleDownloadPDF} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "pdf" ? "Generando..." : "📄 PDF"}
                            </button>
                            <Link href={`/invoices/${id}/edit`} className="btn btn-secondary">
                                ✏️ Editar
                            </Link>
                            <button onClick={handleCreateRectifying} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "rectify" ? "Creando..." : "↩ Rectificativa"}
                            </button>
                            <button onClick={handleVoid} className="btn btn-danger btn-sm" disabled={!!actionLoading}>
                                🚫 Anular
                            </button>
                        </>
                    )}
                    {/* PAID actions: PDF + Editar (campos seguros) + Rectificativa */}
                    {invoice.status === "PAID" && hasNumber && !isProforma && (
                        <>
                            <button onClick={handleDownloadPDF} className="btn btn-secondary" disabled={!!actionLoading}>
                                📄 PDF
                            </button>
                            <Link href={`/invoices/${id}/edit`} className="btn btn-secondary">
                                ✏️ Editar
                            </Link>
                            <button onClick={handleCreateRectifying} className="btn btn-secondary" disabled={!!actionLoading}>
                                {actionLoading === "rectify" ? "Creando..." : "↩ Rectificativa"}
                            </button>
                        </>
                    )}
                    {/* VOID: just PDF */}
                    {invoice.status === "VOID" && hasNumber && (
                        <button onClick={handleDownloadPDF} className="btn btn-secondary" disabled={!!actionLoading}>
                            📄 PDF
                        </button>
                    )}
                    {/* PAID for proformas: just PDF */}
                    {invoice.status === "PAID" && hasNumber && isProforma && (
                        <button onClick={handleDownloadPDF} className="btn btn-secondary" disabled={!!actionLoading}>
                            📄 PDF
                        </button>
                    )}
                    <Link href={isProforma ? "/proformas" : "/invoices"} className="btn btn-ghost">← Volver</Link>
                </div>
            </div>

            {/* Partial Payment Modal */}
            {showPartialModal && (
                <div className="modal-overlay" onClick={() => setShowPartialModal(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <h3 style={{ marginBottom: 16, fontSize: 16, fontWeight: 600 }}>💳 Cobro Parcial</h3>
                        <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 4 }}>
                            Total factura: {formatEur(invoice.totalCents)}
                        </p>
                        {invoice.paidCents > 0 && (
                            <p style={{ fontSize: 13, color: "var(--color-success)", marginBottom: 4 }}>
                                Ya cobrado: {formatEur(invoice.paidCents)}
                            </p>
                        )}
                        <p style={{ fontSize: 13, color: "var(--color-warning)", marginBottom: 12 }}>
                            Pendiente: {formatEur(invoice.totalCents - invoice.paidCents)}
                        </p>
                        <div className="form-group" style={{ marginBottom: 16 }}>
                            <label className="form-label">Importe cobrado (€)</label>
                            <input
                                type="number"
                                className="form-input"
                                value={partialAmount}
                                onChange={(e) => setPartialAmount(e.target.value)}
                                placeholder="0.00"
                                min="0.01"
                                step="0.01"
                                autoFocus
                            />
                        </div>
                        <div className="flex gap-2" style={{ justifyContent: "flex-end" }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => { setShowPartialModal(false); setPartialAmount(""); }}>Cancelar</button>
                            <button className="btn btn-primary btn-sm" onClick={handlePartialPayment} disabled={!!actionLoading}>
                                {actionLoading === "partial" ? "Guardando..." : "Registrar cobro"}
                            </button>
                        </div>
                    </div>
                </div>
            )}



            {/* Invoice info */}
            <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-body">
                    <div className="form-row">
                        <div className="form-group">
                            <label className="form-label">Cliente</label>
                            <p style={{ fontSize: 14, fontWeight: 500 }}>{invoice.client?.name}</p>
                        </div>
                        <div className="form-group">
                            <label className="form-label">NIF</label>
                            <p style={{ fontSize: 14, fontFamily: "var(--font-mono)" }}>{invoice.client?.taxId || "—"}</p>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Fecha emisión</label>
                            <p style={{ fontSize: 14 }}>
                                {invoice.issueDate
                                    ? new Date(invoice.issueDate).toLocaleDateString("es-ES")
                                    : "Sin emitir"}
                            </p>
                        </div>
                        {invoice.dueDate && (
                            <div className="form-group">
                                <label className="form-label">Vencimiento</label>
                                <p style={{ fontSize: 14 }}>{new Date(invoice.dueDate).toLocaleDateString("es-ES")}</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Lines table */}
            <div className="table-container" style={{ marginBottom: 20 }}>
                <table className="data-table">
                    <thead>
                        <tr>
                            <th style={{ width: 30 }}>#</th>
                            <th>Concepto</th>
                            <th>Descripción</th>
                            <th>Cantidad</th>
                            <th>Precio</th>
                            <th>Impuesto</th>
                            <th>Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(invoice.lines || []).map((line: any) => (
                            <tr key={line.id}>
                                <td>{line.position}</td>
                                <td className="cell-primary" style={{ fontWeight: 600 }}>{line.description}</td>
                                <td style={{ color: "var(--color-text-secondary)", fontSize: 13, whiteSpace: "pre-wrap" }}>{line.details || ""}</td>
                                <td>{Number(line.quantity)}</td>
                                <td className="cell-amount">{formatCents(line.unitPriceCents)} €</td>
                                <td>{line.tax?.name || "—"}</td>
                                <td className="cell-amount" style={{ fontWeight: 600 }}>{formatCents(line.lineTotalCents)} €</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Totals */}
            <div className="card">
                <div className="card-body">
                    <div className="lines-totals" style={{ marginLeft: "auto" }}>
                        <div className="lines-totals-row">
                            <span className="lines-totals-label">Subtotal</span>
                            <span className="lines-totals-value">{formatCents(invoice.subtotalCents)} €</span>
                        </div>
                        <div className="lines-totals-row">
                            <span className="lines-totals-label">Impuestos</span>
                            <span className="lines-totals-value">{formatCents(invoice.taxCents)} €</span>
                        </div>
                        <div className="lines-totals-row total">
                            <span className="lines-totals-label">Total</span>
                            <span className="lines-totals-value">{formatCents(invoice.totalCents)} €</span>
                        </div>
                        {invoice.paidCents > 0 && (
                            <>
                                <div className="lines-totals-row" style={{ color: "var(--color-success)" }}>
                                    <span className="lines-totals-label">Pagado</span>
                                    <span className="lines-totals-value">{formatCents(invoice.paidCents)} €</span>
                                </div>
                                <div className="lines-totals-row" style={{ color: "var(--color-warning)" }}>
                                    <span className="lines-totals-label">Pendiente</span>
                                    <span className="lines-totals-value">{formatCents(invoice.totalCents - invoice.paidCents)} €</span>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Adjuntos */}
            <div className="card" style={{ marginTop: 20 }}>
                <div className="card-body">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>📎 Adjuntos</h3>
                        <label
                            className="btn btn-secondary btn-sm"
                            style={{ cursor: "pointer", opacity: uploading ? 0.6 : 1 }}
                        >
                            {uploading ? "Subiendo..." : "+ Subir archivo"}
                            <input
                                type="file"
                                style={{ display: "none" }}
                                disabled={uploading}
                                onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    setUploading(true);
                                    try {
                                        const fd = new FormData();
                                        fd.append("file", file);
                                        fd.append("entityType", "INVOICE");
                                        fd.append("entityId", id as string);
                                        const res = await fetch("/api/documents/upload", {
                                            method: "POST",
                                            body: fd,
                                        });
                                        if (!res.ok) throw new Error((await res.json()).error);
                                        const doc = await res.json();
                                        setDocuments((prev) => [doc, ...prev]);
                                        showSuccess("Archivo subido");
                                    } catch (err: any) {
                                        showError(err.message || "Error al subir archivo");
                                    } finally {
                                        setUploading(false);
                                        e.target.value = "";
                                    }
                                }}
                            />
                        </label>
                    </div>

                    {documents.length === 0 ? (
                        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                            Sin adjuntos. Sube facturas originales, contratos u otros documentos.
                        </p>
                    ) : (
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Archivo</th>
                                    <th>Tamaño</th>
                                    <th>Fecha</th>
                                    <th style={{ width: 100 }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {documents.map((doc) => (
                                    <tr key={doc.id}>
                                        <td className="cell-primary">{doc.filename}</td>
                                        <td>{(doc.sizeBytes / 1024).toFixed(1)} KB</td>
                                        <td>{new Date(doc.createdAt).toLocaleDateString("es-ES")}</td>
                                        <td style={{ display: "flex", gap: 6 }}>
                                            <a
                                                href={`/api/documents/${doc.id}/download`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="btn btn-ghost btn-sm"
                                            >
                                                ⬇
                                            </a>
                                            <button
                                                className="btn btn-danger btn-sm"
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    if (!await showConfirm("¿Eliminar este adjunto?")) return;
                                                    try {
                                                        const res = await fetch(`/api/documents/${doc.id}/download`, {
                                                            method: "DELETE",
                                                        });
                                                        if (!res.ok) throw new Error("Error");
                                                        setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
                                                    } catch {
                                                        showError("Error al eliminar adjunto");
                                                    }
                                                }}
                                            >
                                                🗑
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

        </>
    );
}
