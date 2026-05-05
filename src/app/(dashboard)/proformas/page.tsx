"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useNotification } from "@/components/NotificationContext";

interface ProformaItem {
    id: string;
    year: number | null;
    number: string | null;
    type: string;
    status: string;
    totalCents: number;
    paidCents: number;
    createdAt: string;
    issueDate: string | null;
    client: { name: string };
}

function formatCents(cents: number): string {
    return (cents / 100).toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }) + " €";
}

const STATUS_LABELS: Record<string, { label: string; class: string }> = {
    DRAFT: { label: "Borrador", class: "badge-draft" },
    ISSUED: { label: "Emitida", class: "badge-info" },
    VOID: { label: "Anulada", class: "badge-danger" },
};

// ── Actions Dropdown ──────────────────────────────────────

function ActionsDropdown({ proforma, onRefresh }: { proforma: ProformaItem; onRefresh: () => void }) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const { showConfirm, showSuccess, showError } = useNotification();

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        if (open) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open]);

    async function handleDownloadPDF() {
        setLoading("pdf");
        try {
            const res = await fetch(`/api/invoices/${proforma.id}/pdf`);
            if (!res.ok) throw new Error("Error al generar PDF");
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `proforma-${proforma.number || proforma.id}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (err) { console.error(err); } finally { setLoading(""); setOpen(false); }
    }

    async function handleEmit() {
        if (!await showConfirm("¿Emitir proforma? Se asignará número definitivo.")) return;
        setLoading("emit");
        try {
            const res = await fetch(`/api/proformas/${proforma.id}/emit`, { method: "POST" });
            if (!res.ok) throw new Error((await res.json()).error);
            showSuccess("Proforma emitida");
            onRefresh();
        } catch (err: any) { showError(err.message); } finally { setLoading(""); setOpen(false); }
    }

    async function handleConvert() {
        if (!await showConfirm("¿Convertir esta proforma en factura? Se creará una nueva factura borrador con los mismos datos.")) return;
        setLoading("convert");
        try {
            const res = await fetch(`/api/proformas/${proforma.id}/convert`, { method: "POST" });
            if (!res.ok) throw new Error((await res.json()).error);
            const newInvoice = await res.json();
            showSuccess("Factura creada desde proforma");
            router.push(`/invoices/${newInvoice.id}`);
        } catch (err: any) { showError(err.message); } finally { setLoading(""); setOpen(false); }
    }

    async function handleSendEmail() {
        if (!await showConfirm("¿Enviar proforma por email al cliente?")) return;
        setLoading("send");
        try {
            const res = await fetch(`/api/invoices/${proforma.id}/send`, { method: "POST" });
            if (!res.ok) throw new Error((await res.json()).error);
            showSuccess("Proforma enviada por email");
            onRefresh();
        } catch (err: any) { showError(err.message); } finally { setLoading(""); setOpen(false); }
    }

    async function handleDelete() {
        if (!await showConfirm("¿Eliminar esta proforma?")) return;
        try {
            const res = await fetch(`/api/invoices/${proforma.id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Error al eliminar");
            onRefresh();
        } catch (err: any) { showError(err.message); } finally { setOpen(false); }
    }

    const isDraft = proforma.status === "DRAFT";
    const isIssued = proforma.status === "ISSUED";

    return (
        <div className="actions-dropdown" ref={ref}>
            <button className="btn btn-ghost btn-sm actions-dropdown-trigger" onClick={(e) => { e.stopPropagation(); setOpen(!open); }} disabled={!!loading}>
                {loading ? <span className="spinner-sm" /> : "⋯"}
            </button>
            {open && (
                <div className="actions-dropdown-menu" onClick={(e) => e.stopPropagation()}>
                    <Link href={`/invoices/${proforma.id}`} className="actions-dropdown-item">👁️ Ver detalle</Link>
                    <button className="actions-dropdown-item" onClick={handleDownloadPDF}>📄 Descargar PDF</button>
                    <div className="actions-dropdown-divider" />
                    {isDraft && (<>
                        <button className="actions-dropdown-item" onClick={handleEmit}>📋 Emitir</button>
                        <div className="actions-dropdown-divider" />
                        <button className="actions-dropdown-item actions-dropdown-danger" onClick={handleDelete}>🗑️ Eliminar</button>
                    </>)}
                    {isIssued && (<>
                        <button className="actions-dropdown-item" onClick={handleConvert}>📄 Convertir a Factura</button>
                        <button className="actions-dropdown-item" onClick={handleSendEmail}>📧 Enviar email</button>
                    </>)}
                </div>
            )}
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────

export default function ProformasPage() {
    const [proformas, setProformas] = useState<ProformaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState("");
    const router = useRouter();

    const now = new Date();
    const [dateFrom, setDateFrom] = useState(`${now.getFullYear()}-01-01`);
    const [dateTo, setDateTo] = useState(`${now.getFullYear()}-12-31`);

    useEffect(() => {
        fetchProformas();
    }, [filter, dateFrom, dateTo]);

    async function fetchProformas() {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (filter) params.set("status", filter);
            if (dateFrom) params.set("from", dateFrom);
            if (dateTo) params.set("to", dateTo);
            const res = await fetch(`/api/proformas?${params}`);
            const data = await res.json();
            setProformas(Array.isArray(data) ? data : []);
        } catch (err) { console.error(err); } finally { setLoading(false); }
    }

    return (
        <>
            <div className="page-header">
                <div>
                    <h1>Facturas Proforma</h1>
                    <p className="page-header-sub">{proformas.length} proforma{proformas.length !== 1 ? "s" : ""}</p>
                </div>
                <div className="flex gap-2">
                    <Link href="/proformas/new" className="btn btn-primary">+ Nueva proforma</Link>
                </div>
            </div>

            {/* Filters */}
            <div className="filter-bar">
                {[
                    { value: "", label: "Todas" },
                    { value: "DRAFT", label: "Borradores" },
                    { value: "ISSUED", label: "Emitidas" },
                    { value: "VOID", label: "Anuladas" },
                ].map((f) => (
                    <button key={f.value} className={`btn ${filter === f.value ? "btn-primary" : "btn-secondary"} btn-sm`} onClick={() => setFilter(f.value)}>
                        {f.label}
                    </button>
                ))}
                <div style={{ flex: 1 }} />
                <div className="filter-date-group">
                    <label>📅 Desde</label>
                    <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </div>
                <div className="filter-date-group">
                    <label>Hasta</label>
                    <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                </div>
            </div>

            {/* Table */}
            <div className="table-container">
                {loading ? (
                    <div className="loading-center"><div className="spinner" /></div>
                ) : proformas.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">📋</div>
                        <h3>No hay proformas</h3>
                        <p>Crea una factura proforma para enviar a tus clientes antes de facturar</p>
                        <Link href="/proformas/new" className="btn btn-primary" style={{ marginTop: 12 }}>+ Nueva proforma</Link>
                    </div>
                ) : (
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Número</th>
                                <th>Cliente</th>
                                <th>Estado</th>
                                <th>Total</th>
                                <th>Fecha</th>
                                <th style={{ width: 50 }}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {proformas.map((pf) => {
                                const st = STATUS_LABELS[pf.status] || { label: pf.status, class: "badge-draft" };
                                return (
                                    <tr key={pf.id} style={{ cursor: "pointer" }} onClick={() => router.push(`/invoices/${pf.id}`)}>
                                        <td className="cell-mono cell-primary">{pf.number || "Borrador"}</td>
                                        <td className="cell-primary">{pf.client.name}</td>
                                        <td><span className={`badge ${st.class}`}>{st.label}</span></td>
                                        <td className="cell-amount">{formatCents(pf.totalCents)}</td>
                                        <td>{pf.issueDate ? new Date(pf.issueDate).toLocaleDateString("es-ES") : new Date(pf.createdAt).toLocaleDateString("es-ES")}</td>
                                        <td className="text-right" style={{ position: "relative" }}>
                                            <ActionsDropdown proforma={pf} onRefresh={fetchProformas} />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </>
    );
}
