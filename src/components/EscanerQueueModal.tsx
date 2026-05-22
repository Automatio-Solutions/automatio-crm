"use client";

// ============================================================
// EscanerQueueModal — escáner multi-documento con cola.
//
// Características portadas desde el EscanerScreen de CRM Dani:
//  - Cola visible con estados por item (queued/uploading/scanning/review/...)
//  - Pool de procesado: hasta 3 archivos a la vez
//  - AbortSignal con timeout cliente de 120 s
//  - Contador de segundos en vivo + aviso a los 25 s
//  - Auto-avance al siguiente pendiente tras "Confirmar y crear factura"
//
// Diseño: 3 columnas → Cola | Preview del documento | Formulario editable
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScannedAttachment, ScannedInvoiceData } from "@/components/InvoiceScanner";

const CONCURRENCY = 3;
const SCAN_TIMEOUT_MS = 120_000; // 2 minutos: corta si la API se cuelga
const SLOW_WARNING_SECS = 25;

type ItemStatus =
    | "queued"
    | "uploading"
    | "scanning"
    | "review"
    | "saving"
    | "saved"
    | "error";

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
    quantity: string;
    unitPriceEuros: string;
    taxId: string;
    taxRate: number;
    retentionPct: string;
}

type Status = "DRAFT" | "BOOKED" | "PAID";

const STATUSES: { id: Status; label: string; dot: string }[] = [
    { id: "DRAFT", label: "Borrador", dot: "var(--color-text-muted)" },
    { id: "BOOKED", label: "Contabilizada", dot: "var(--color-warning)" },
    { id: "PAID", label: "Pagada", dot: "var(--color-success)" },
];

interface ScanItem {
    id: string;
    file: File;
    status: ItemStatus;
    error?: string;
    startedAt?: number; // ms timestamp para el timer en vivo
    // Tras escaneo:
    scanData?: ScannedInvoiceData;
    // Estado editable del formulario:
    formProviderId?: string;
    formProviderName?: string;
    formProviderTaxId?: string;
    formProviderAutoCreated?: boolean;
    formInvoiceNumber?: string;
    formIssueDate?: string;
    formDueDate?: string;
    formStatus?: Status;
    formNotes?: string;
    formLines?: LineItem[];
    // Tras guardar:
    purchaseId?: string;
}

interface EscanerQueueModalProps {
    isOpen: boolean;
    /** Archivos iniciales con los que se abre el modal. Si está vacío, no se abre. */
    initialFiles: File[];
    providers: Provider[];
    taxes: Tax[];
    onClose: () => void;
    /** Se llama cuando el modal se cierra, con los IDs de las facturas creadas. */
    onAllSaved?: (purchaseIds: string[]) => void;
    onProvidersChanged?: (providers: Provider[]) => void;
    onError?: (message: string) => void;
}

const STATUS_META: Record<ItemStatus, { label: string; color: string }> = {
    queued: { label: "En cola", color: "var(--color-text-muted)" },
    uploading: { label: "Subiendo", color: "var(--color-primary)" },
    scanning: { label: "Procesando", color: "var(--color-primary)" },
    review: { label: "Revisar", color: "var(--color-warning)" },
    saving: { label: "Creando", color: "var(--color-primary)" },
    saved: { label: "Guardado", color: "var(--color-success)" },
    error: { label: "Error", color: "var(--color-danger)" },
};

export default function EscanerQueueModal({
    isOpen,
    initialFiles,
    providers,
    taxes,
    onClose,
    onAllSaved,
    onProvidersChanged,
    onError,
}: EscanerQueueModalProps) {
    const [items, setItems] = useState<ScanItem[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // Ref con los items actuales: la usan callbacks asíncronos (workers del pool, auto-avance)
    const itemsRef = useRef<ScanItem[]>([]);
    useEffect(() => {
        itemsRef.current = items;
    }, [items]);

    // Reset al cerrar el modal
    useEffect(() => {
        if (!isOpen) {
            setItems([]);
            setSelectedId(null);
        }
    }, [isOpen]);

    const updateItem = useCallback((id: string, patch: Partial<ScanItem>) => {
        setItems((arr) => arr.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    }, []);

    const newId = () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

    // ── Pool de procesado ───────────────────────────────────
    const processItem = useCallback(
        async (item: ScanItem) => {
            // 1) marcar como subiendo y arrancar timer
            updateItem(item.id, { status: "uploading", startedAt: Date.now() });

            const fd = new FormData();
            fd.append("file", item.file);

            // 2) llamada al endpoint /api/purchases/scan
            //    (el server hace tanto el upload a Storage como el escaneo)
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), SCAN_TIMEOUT_MS);

            try {
                // Pasamos a "scanning" justo antes del fetch para que el contador
                // se reinicie al entrar en la fase larga.
                updateItem(item.id, { status: "scanning", startedAt: Date.now() });

                const res = await fetch("/api/purchases/scan", {
                    method: "POST",
                    body: fd,
                    signal: ac.signal,
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data?.error || `HTTP ${res.status}`);
                }
                const scanData: ScannedInvoiceData = data;

                // Pre-rellenar el formulario para esta línea
                const { formState } = buildFormFromScan(scanData, providers, taxes);

                updateItem(item.id, {
                    status: "review",
                    startedAt: undefined,
                    scanData,
                    ...formState,
                });
            } catch (e: unknown) {
                const err = e as { name?: string; message?: string };
                const msg =
                    err?.name === "AbortError"
                        ? `El escaneo tardó más de ${SCAN_TIMEOUT_MS / 1000}s y se canceló. Intenta con un PDF más pequeño.`
                        : err?.message || "Error en el escaneo";
                updateItem(item.id, { status: "error", error: msg, startedAt: undefined });
            } finally {
                clearTimeout(timer);
            }
        },
        [updateItem, providers, taxes]
    );

    // Lanza un pool que procesa N items a la vez
    const startPool = useCallback(
        (toProcess: ScanItem[]) => {
            const queue = [...toProcess];
            const workers = Array.from(
                { length: Math.min(CONCURRENCY, queue.length) },
                async () => {
                    while (queue.length > 0) {
                        const it = queue.shift();
                        if (!it) return;
                        await processItem(it);
                    }
                }
            );
            void Promise.all(workers);
        },
        [processItem]
    );

    // Cuando llegan archivos iniciales, los añadimos a la cola y arrancamos el pool.
    // Usamos una ref para no relanzar el pool si initialFiles cambia de referencia pero
    // contiene los mismos archivos. El pool se lanza una sola vez por "tanda".
    const lastFilesRef = useRef<File[] | null>(null);
    useEffect(() => {
        if (!isOpen) return;
        if (!initialFiles || initialFiles.length === 0) return;
        if (lastFilesRef.current === initialFiles) return;
        lastFilesRef.current = initialFiles;

        const newItems: ScanItem[] = initialFiles.map((f) => ({
            id: newId(),
            file: f,
            status: "queued",
        }));
        setItems((arr) => [...arr, ...newItems]);
        if (newItems[0] && !selectedId) setSelectedId(newItems[0].id);
        startPool(newItems);
    }, [isOpen, initialFiles, selectedId, startPool]);

    // ── Añadir más archivos sobre la marcha ─────────────────
    const addMoreInputRef = useRef<HTMLInputElement>(null);
    const handleAddMore = (files: FileList | null) => {
        if (!files || files.length === 0) return;
        const newItems: ScanItem[] = Array.from(files).map((f) => ({
            id: newId(),
            file: f,
            status: "queued",
        }));
        setItems((arr) => [...arr, ...newItems]);
        if (!selectedId && newItems[0]) setSelectedId(newItems[0].id);
        startPool(newItems);
    };

    // ── Navegación + auto-avance ────────────────────────────
    const findNextPending = useCallback((excludeId?: string) => {
        return (
            itemsRef.current.find(
                (it) =>
                    it.id !== excludeId &&
                    (it.status === "review" ||
                        it.status === "scanning" ||
                        it.status === "uploading" ||
                        it.status === "queued")
            ) || null
        );
    }, []);

    const pendingCount = useMemo(
        () =>
            items.filter(
                (it) =>
                    it.status === "queued" ||
                    it.status === "uploading" ||
                    it.status === "scanning" ||
                    it.status === "review"
            ).length,
        [items]
    );

    const allSavedIds = useMemo(
        () =>
            items
                .filter((it) => it.status === "saved" && it.purchaseId)
                .map((it) => it.purchaseId as string),
        [items]
    );

    // ── Edición del formulario por item ─────────────────────
    const patchSelectedForm = (patch: Partial<ScanItem>) => {
        if (!selectedId) return;
        updateItem(selectedId, patch);
    };

    const selected = items.find((x) => x.id === selectedId) || null;

    // ── Auto-crear proveedor ────────────────────────────────
    async function handleAutoCreateProvider() {
        if (!selected) return;
        const name = (selected.formProviderName || "").trim();
        if (!name) {
            onError?.("Hace falta un nombre para crear el proveedor.");
            return;
        }
        try {
            const res = await fetch("/api/providers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    taxId: (selected.formProviderTaxId || "").trim() || null,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Error al crear el proveedor");
            }
            const newProvider: Provider = await res.json();
            onProvidersChanged?.([newProvider, ...providers]);
            patchSelectedForm({
                formProviderId: newProvider.id,
                formProviderAutoCreated: true,
            });
        } catch (e) {
            onError?.(e instanceof Error ? e.message : "Error al crear el proveedor");
        }
    }

    // ── Confirmar y crear factura ───────────────────────────
    async function handleConfirm() {
        if (!selected) return;
        const providerId = selected.formProviderId || "";
        const lines = selected.formLines || [];

        if (!providerId) {
            onError?.("Selecciona o crea un proveedor antes de confirmar.");
            return;
        }
        if (lines.length === 0 || !lines.some((l) => l.description.trim())) {
            onError?.("Añade al menos una línea con descripción.");
            return;
        }

        updateItem(selected.id, { status: "saving" });
        try {
            const totals = computeTotals(lines);

            const res = await fetch("/api/purchases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    providerId,
                    providerInvoiceNumber: selected.formInvoiceNumber || null,
                    issueDate: selected.formIssueDate || null,
                    dueDate: selected.formDueDate || null,
                    notes: selected.formNotes || null,
                    status: selected.formStatus || "DRAFT",
                    retentionCents: totals.retentionCents,
                    retentionPct:
                        totals.subtotalCents > 0
                            ? (totals.retentionCents * 100) / totals.subtotalCents
                            : 0,
                    lines: lines.map((l) => ({
                        description: l.description,
                        details: l.details || null,
                        quantity: l.quantity,
                        unitPriceCents: String(
                            Math.round((parseFloat(l.unitPriceEuros) || 0) * 100)
                        ),
                        taxId: l.taxId || null,
                        taxRate: l.taxRate,
                    })),
                    attachment: selected.scanData?.attachment ?? null,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Error al crear la factura");
            }
            const purchase = await res.json();
            updateItem(selected.id, { status: "saved", purchaseId: purchase.id });

            // Auto-avance al siguiente pendiente (incluye los que aún están en scanning)
            setTimeout(() => {
                const next = findNextPending(selected.id);
                if (next) setSelectedId(next.id);
            }, 250);
        } catch (e) {
            onError?.(e instanceof Error ? e.message : "Error al guardar");
            updateItem(selected.id, { status: "review" });
        }
    }

    function handleCloseModal() {
        // Si todavía hay items pendientes, avisar.
        if (pendingCount > 0) {
            const ok = window.confirm(
                `Tienes ${pendingCount} documento${pendingCount === 1 ? "" : "s"} sin guardar. ¿Cerrar igualmente?`
            );
            if (!ok) return;
        }
        onAllSaved?.(allSavedIds);
        onClose();
    }

    if (!isOpen) return null;

    // ── Render ──────────────────────────────────────────────
    return (
        <div className="modal-overlay" onClick={handleCloseModal} style={{ padding: 24 }}>
            <div
                className="modal-content"
                onClick={(e) => e.stopPropagation()}
                style={{
                    maxWidth: "1400px",
                    width: "96vw",
                    height: "92vh",
                    maxHeight: "92vh",
                }}
            >
                {/* Cabecera global */}
                <div
                    className="modal-header"
                    style={{ gap: 16, flexShrink: 0 }}
                >
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="modal-title">
                            Escáner de facturas{" "}
                            <span
                                style={{
                                    fontSize: 13,
                                    color: "var(--color-text-muted)",
                                    fontWeight: 400,
                                    marginLeft: 6,
                                }}
                            >
                                ({items.length} {items.length === 1 ? "documento" : "documentos"} ·{" "}
                                {pendingCount} pendiente{pendingCount === 1 ? "" : "s"})
                            </span>
                        </div>
                        <div
                            style={{
                                fontSize: 12,
                                color: "var(--color-text-muted)",
                                marginTop: 4,
                            }}
                        >
                            Claude Haiku 4.5 · hasta {CONCURRENCY} en paralelo · timeout {SCAN_TIMEOUT_MS / 1000}s
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => addMoreInputRef.current?.click()}
                        >
                            + Añadir más
                        </button>
                        <input
                            ref={addMoreInputRef}
                            type="file"
                            multiple
                            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                            onChange={(e) => {
                                handleAddMore(e.target.files);
                                if (addMoreInputRef.current) addMoreInputRef.current.value = "";
                            }}
                            style={{ display: "none" }}
                        />
                        <button
                            className="btn-close"
                            onClick={handleCloseModal}
                            title="Cerrar"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Body: cola | preview | formulario */}
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "240px 1.1fr 1fr",
                        flex: 1,
                        minHeight: 0,
                        overflow: "hidden",
                    }}
                >
                    {/* Cola */}
                    <QueueList
                        items={items}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        onRetry={(it) => {
                            updateItem(it.id, { status: "queued", error: undefined });
                            void processItem(it);
                        }}
                    />

                    {/* Panel derecho según estado del item seleccionado */}
                    {!selected ? (
                        <EmptyState />
                    ) : selected.status === "queued" ||
                      selected.status === "uploading" ||
                      selected.status === "scanning" ? (
                        <>
                            <DocumentPreview attachment={selected.scanData?.attachment ?? null} />
                            <ProcessingView item={selected} />
                        </>
                    ) : selected.status === "error" ? (
                        <>
                            <DocumentPreview attachment={selected.scanData?.attachment ?? null} />
                            <ErrorView
                                message={selected.error || "Error desconocido"}
                                onRetry={() => {
                                    updateItem(selected.id, { status: "queued", error: undefined });
                                    void processItem(selected);
                                }}
                            />
                        </>
                    ) : selected.status === "saved" ? (
                        <>
                            <DocumentPreview attachment={selected.scanData?.attachment ?? null} />
                            <SavedView
                                purchaseId={selected.purchaseId}
                                hasNext={!!findNextPending(selected.id)}
                                onNext={() => {
                                    const n = findNextPending(selected.id);
                                    if (n) setSelectedId(n.id);
                                }}
                            />
                        </>
                    ) : (
                        // review o saving
                        <>
                            <DocumentPreview attachment={selected.scanData?.attachment ?? null} />
                            <ReviewForm
                                item={selected}
                                providers={providers}
                                taxes={taxes}
                                onPatch={patchSelectedForm}
                                onAutoCreateProvider={handleAutoCreateProvider}
                                onConfirm={handleConfirm}
                                onDiscard={() => {
                                    // descartar este item: lo quitamos y avanzamos
                                    setItems((arr) => arr.filter((x) => x.id !== selected.id));
                                    const next = findNextPending(selected.id);
                                    setSelectedId(next ? next.id : null);
                                }}
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// ============================================================
// Cola (izquierda)
// ============================================================
function QueueList({
    items,
    selectedId,
    onSelect,
    onRetry,
}: {
    items: ScanItem[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onRetry: (it: ScanItem) => void;
}) {
    return (
        <div
            style={{
                borderRight: "1px solid var(--color-border-subtle)",
                background: "var(--color-bg-secondary)",
                overflow: "auto",
                display: "flex",
                flexDirection: "column",
            }}
        >
            <div
                style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--color-border-subtle)",
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: "var(--color-text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    flexShrink: 0,
                }}
            >
                Cola ({items.length})
            </div>
            {items.length === 0 ? (
                <div
                    style={{
                        padding: 24,
                        textAlign: "center",
                        color: "var(--color-text-muted)",
                        fontSize: 12.5,
                    }}
                >
                    Sin documentos
                </div>
            ) : (
                items.map((it) => {
                    const meta = STATUS_META[it.status];
                    const active = it.id === selectedId;
                    return (
                        <button
                            key={it.id}
                            type="button"
                            onClick={() => onSelect(it.id)}
                            style={{
                                width: "100%",
                                textAlign: "left",
                                padding: "10px 14px",
                                borderBottom: "1px solid var(--color-border-subtle)",
                                background: active ? "var(--color-surface)" : "transparent",
                                border: "none",
                                borderLeft: active
                                    ? "3px solid var(--color-primary)"
                                    : "3px solid transparent",
                                cursor: "pointer",
                                display: "flex",
                                flexDirection: "column",
                                gap: 6,
                            }}
                        >
                            <div
                                style={{
                                    fontSize: 12.5,
                                    fontWeight: 500,
                                    color: "var(--color-text)",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                }}
                            >
                                {it.file.name}
                            </div>
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    fontSize: 11,
                                    color: "var(--color-text-muted)",
                                }}
                            >
                                <span
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 4,
                                        padding: "1px 7px",
                                        borderRadius: "var(--radius-full)",
                                        background: "var(--color-bg-tertiary)",
                                        color: meta.color,
                                        fontWeight: 500,
                                    }}
                                >
                                    {(it.status === "uploading" ||
                                        it.status === "scanning" ||
                                        it.status === "saving") && (
                                        <span
                                            style={{
                                                width: 6,
                                                height: 6,
                                                borderRadius: "50%",
                                                background: "currentColor",
                                                animation: "queue-pulse 1.2s infinite",
                                            }}
                                        />
                                    )}
                                    {meta.label}
                                </span>
                                <span>{(it.file.size / 1024).toFixed(0)} KB</span>
                            </div>
                            {it.status === "error" && (
                                <span
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRetry(it);
                                    }}
                                    style={{
                                        fontSize: 11,
                                        color: "var(--color-primary)",
                                        textDecoration: "underline",
                                        cursor: "pointer",
                                    }}
                                >
                                    Reintentar
                                </span>
                            )}
                        </button>
                    );
                })
            )}
            <style jsx>{`
                @keyframes queue-pulse {
                    0%, 100% { opacity: 0.5; }
                    50% { opacity: 1; }
                }
            `}</style>
        </div>
    );
}

// ============================================================
// Preview del documento (columna central)
// ============================================================
function DocumentPreview({ attachment }: { attachment: ScannedAttachment | null }) {
    if (!attachment) {
        return (
            <div
                style={{
                    borderRight: "1px solid var(--color-border-subtle)",
                    background: "var(--color-bg-secondary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--color-text-muted)",
                    fontSize: 13,
                    padding: 16,
                }}
            >
                Subiendo a Storage…
            </div>
        );
    }
    const isPdf = attachment.mimeType === "application/pdf";
    const isImage = attachment.mimeType.startsWith("image/");
    return (
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
            {isPdf ? (
                <iframe
                    src={attachment.publicUrl}
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
                    src={attachment.publicUrl}
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
                    Vista previa no disponible
                </div>
            )}
        </div>
    );
}

// ============================================================
// ProcessingView (cuando el item está queued/uploading/scanning)
// Con contador de segundos en vivo y aviso de lentitud
// ============================================================
function ProcessingView({ item }: { item: ScanItem }) {
    const [secs, setSecs] = useState(0);
    useEffect(() => {
        if (!item.startedAt) {
            setSecs(0);
            return;
        }
        const tick = () =>
            setSecs(Math.floor((Date.now() - (item.startedAt as number)) / 1000));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [item.startedAt, item.status]);

    const isSlow = secs > SLOW_WARNING_SECS && item.status === "scanning";
    const emoji =
        item.status === "queued" ? "⏳" : item.status === "uploading" ? "📤" : "🔍";

    return (
        <div
            style={{
                padding: "100px 24px",
                textAlign: "center",
                color: "var(--color-text-muted)",
                fontSize: 14,
                overflow: "auto",
            }}
        >
            <div style={{ fontSize: 32, marginBottom: 16 }}>{emoji}</div>
            <div style={{ fontWeight: 500, color: "var(--color-text)" }}>
                {STATUS_META[item.status].label}…
                {item.startedAt && item.status !== "queued" && (
                    <span
                        style={{
                            color: "var(--color-text-muted)",
                            fontWeight: 400,
                            marginLeft: 6,
                        }}
                    >
                        ({secs}s)
                    </span>
                )}
            </div>
            {isSlow && (
                <div
                    style={{
                        marginTop: 16,
                        fontSize: 12.5,
                        color: "var(--color-text-muted)",
                        maxWidth: 380,
                        margin: "16px auto 0",
                    }}
                >
                    Los PDFs con muchas páginas pueden tardar más de un minuto. Se
                    cancelará automáticamente a los {SCAN_TIMEOUT_MS / 1000}s.
                </div>
            )}
        </div>
    );
}

// ============================================================
// ErrorView
// ============================================================
function ErrorView({
    message,
    onRetry,
}: {
    message: string;
    onRetry: () => void;
}) {
    return (
        <div
            style={{
                padding: 32,
                background: "var(--color-danger-muted)",
                overflow: "auto",
            }}
        >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div
                    style={{
                        flexShrink: 0,
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        background: "var(--color-danger)",
                        color: "white",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: 14,
                    }}
                >
                    !
                </div>
                <div style={{ flex: 1 }}>
                    <div
                        style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: "var(--color-danger)",
                        }}
                    >
                        Algo salió mal
                    </div>
                    <div
                        style={{
                            fontSize: 13,
                            color: "var(--color-text-secondary)",
                            marginTop: 6,
                            lineHeight: 1.5,
                        }}
                    >
                        {message}
                    </div>
                    <div style={{ marginTop: 14 }}>
                        <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={onRetry}
                        >
                            Reintentar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ============================================================
// SavedView
// ============================================================
function SavedView({
    purchaseId,
    hasNext,
    onNext,
}: {
    purchaseId?: string;
    hasNext: boolean;
    onNext: () => void;
}) {
    return (
        <div
            style={{
                padding: "60px 28px",
                textAlign: "center",
                overflow: "auto",
            }}
        >
            <div
                style={{
                    width: 64,
                    height: 64,
                    borderRadius: "50%",
                    background: "var(--color-success-muted)",
                    color: "var(--color-success)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto 18px",
                    fontSize: 28,
                    fontWeight: 700,
                }}
            >
                ✓
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
                Factura creada
            </div>
            <div
                style={{
                    fontSize: 13,
                    color: "var(--color-text-muted)",
                    marginBottom: 20,
                }}
            >
                Aparece en /purchases.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                {hasNext && (
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={onNext}
                    >
                        Siguiente factura
                    </button>
                )}
                {purchaseId && (
                    <a
                        href={`/purchases/${purchaseId}`}
                        className="btn btn-secondary"
                    >
                        Abrir factura
                    </a>
                )}
            </div>
        </div>
    );
}

// ============================================================
// EmptyState (cuando no hay nada seleccionado)
// ============================================================
function EmptyState() {
    return (
        <div
            style={{
                gridColumn: "span 2",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--color-text-muted)",
                fontSize: 14,
            }}
        >
            Selecciona un documento de la cola
        </div>
    );
}

// ============================================================
// ReviewForm (panel derecho cuando el item está en review/saving)
// ============================================================
function ReviewForm({
    item,
    providers,
    taxes,
    onPatch,
    onAutoCreateProvider,
    onConfirm,
    onDiscard,
}: {
    item: ScanItem;
    providers: Provider[];
    taxes: Tax[];
    onPatch: (patch: Partial<ScanItem>) => void;
    onAutoCreateProvider: () => void;
    onConfirm: () => void;
    onDiscard: () => void;
}) {
    const isSaving = item.status === "saving";
    const matchedProvider = providers.find((p) => p.id === item.formProviderId);
    const lines = item.formLines || [];
    const totals = useMemo(() => computeTotals(lines), [lines]);
    const scanData = item.scanData;

    const updateLine = (key: string, field: keyof LineItem, value: string) => {
        onPatch({
            formLines: lines.map((l) => {
                if (l.key !== key) return l;
                const updated = { ...l, [field]: value };
                if (field === "taxId") {
                    const t = taxes.find((tt) => tt.id === value);
                    updated.taxRate = t?.rate || 0;
                }
                return updated;
            }),
        });
    };
    const addLine = () => onPatch({ formLines: [...lines, emptyLine()] });
    const removeLine = (key: string) =>
        onPatch({ formLines: lines.filter((l) => l.key !== key) });

    return (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Header sticky con confianza + acciones */}
            <div
                style={{
                    padding: "12px 18px",
                    borderBottom: "1px solid var(--color-border-subtle)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    flexShrink: 0,
                }}
            >
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                        style={{
                            fontSize: 14,
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                        }}
                    >
                        {item.file.name}
                    </div>
                    <div
                        style={{
                            fontSize: 11.5,
                            color: "var(--color-text-muted)",
                            marginTop: 2,
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                            flexWrap: "wrap",
                        }}
                    >
                        <span>Datos extraídos · revisa y confirma</span>
                        {scanData?.confidence != null && (
                            <>
                                <span>·</span>
                                <ConfidenceBadge confidence={scanData.confidence} />
                            </>
                        )}
                    </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={onDiscard}
                        disabled={isSaving}
                    >
                        Descartar
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={onConfirm}
                        disabled={isSaving}
                    >
                        {isSaving ? "Creando…" : "Confirmar y crear factura"}
                    </button>
                </div>
            </div>

            {/* Avisos */}
            {scanData?.warnings && scanData.warnings.length > 0 && (
                <div
                    style={{
                        padding: "10px 18px",
                        background: "var(--color-warning-muted)",
                        borderBottom: "1px solid var(--color-border-subtle)",
                        fontSize: 12.5,
                        color: "var(--color-warning)",
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                        lineHeight: 1.5,
                        flexShrink: 0,
                    }}
                >
                    <span style={{ flexShrink: 0, marginTop: 2 }}>⚠</span>
                    <div>
                        <strong style={{ fontWeight: 600 }}>Avisos del escaneo:</strong>{" "}
                        {scanData.warnings.join(" · ")}
                    </div>
                </div>
            )}

            {/* Formulario con scroll propio */}
            <div
                style={{
                    padding: 22,
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                    overflow: "auto",
                }}
            >
                {/* Proveedor */}
                <Field label="Proveedor">
                    <select
                        className="form-input"
                        value={item.formProviderId || ""}
                        onChange={(e) =>
                            onPatch({
                                formProviderId: e.target.value,
                                formProviderAutoCreated: false,
                            })
                        }
                    >
                        <option value="">— Sin seleccionar —</option>
                        {providers.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                                {p.taxId ? ` (${p.taxId})` : ""}
                            </option>
                        ))}
                    </select>
                    {!item.formProviderId && (item.formProviderName || "").trim() && (
                        <div style={{ marginTop: 6 }}>
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={onAutoCreateProvider}
                                style={{
                                    fontSize: 12,
                                    color: "var(--color-primary)",
                                    padding: "4px 8px",
                                }}
                            >
                                + Crear «{item.formProviderName}»
                                {item.formProviderTaxId
                                    ? ` (${item.formProviderTaxId})`
                                    : ""}
                            </button>
                        </div>
                    )}
                    {item.formProviderId && item.formProviderAutoCreated && (
                        <ProviderTag tone="primary">Proveedor creado automáticamente</ProviderTag>
                    )}
                    {item.formProviderId &&
                        !item.formProviderAutoCreated &&
                        matchedProvider && (
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
                            value={item.formProviderTaxId || ""}
                            onChange={(e) =>
                                onPatch({ formProviderTaxId: e.target.value })
                            }
                            disabled={!!item.formProviderId}
                        />
                    </Field>
                    <Field label="Nº factura proveedor">
                        <input
                            type="text"
                            className="form-input"
                            value={item.formInvoiceNumber || ""}
                            onChange={(e) =>
                                onPatch({ formInvoiceNumber: e.target.value })
                            }
                        />
                    </Field>
                </div>

                <div className="form-row">
                    <Field label="Fecha emisión">
                        <input
                            type="date"
                            className="form-input"
                            value={item.formIssueDate || ""}
                            onChange={(e) => onPatch({ formIssueDate: e.target.value })}
                        />
                    </Field>
                    <Field label="Fecha vencimiento">
                        <input
                            type="date"
                            className="form-input"
                            value={item.formDueDate || ""}
                            onChange={(e) => onPatch({ formDueDate: e.target.value })}
                        />
                    </Field>
                </div>

                <Field label="Estado">
                    <StatusPills
                        value={item.formStatus || "DRAFT"}
                        onChange={(v) => onPatch({ formStatus: v })}
                    />
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

                {/* Totales */}
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
                    {totals.retentionCents > 0 && (
                        <Row
                            label="Retención IRPF"
                            value={`− ${fmtEuros(totals.retentionCents)}`}
                            tone="danger"
                        />
                    )}
                    <Row label="Total" value={fmtEuros(totals.totalCents)} bold />
                </div>

                <Field label="Notas">
                    <textarea
                        className="form-input"
                        value={item.formNotes || ""}
                        onChange={(e) => onPatch({ formNotes: e.target.value })}
                        placeholder="Notas internas sobre la factura"
                        rows={3}
                        style={{ minHeight: 70, resize: "vertical" }}
                    />
                </Field>
            </div>
        </div>
    );
}

// ============================================================
// Subcomponentes pequeños
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
    const lineRetPct = parseFloat(line.retentionPct) || 0;
    const ret = Math.round((sub * lineRetPct) / 100);
    const total = sub + tax - ret;

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

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "60px 1fr 1.1fr 80px 110px",
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
                    <MiniLabel>Ret. %</MiniLabel>
                    <input
                        className="form-input"
                        type="number"
                        value={line.retentionPct === "0" ? "" : line.retentionPct}
                        onChange={(e) => onUpdate("retentionPct", e.target.value || "0")}
                        min="0"
                        max="100"
                        step="0.01"
                        placeholder="0"
                    />
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
// Helpers de inicialización + cálculo
// ============================================================

/** Construye el estado inicial del formulario a partir del escaneo. */
function buildFormFromScan(
    scanData: ScannedInvoiceData,
    providers: Provider[],
    taxes: Tax[]
): { formState: Partial<ScanItem> } {
    const normalize = (s: string) => s.replace(/[\s\-.]/g, "").toLowerCase();
    const nifNorm = scanData.providerTaxId ? normalize(scanData.providerTaxId) : "";
    const nameNorm = scanData.providerName ? normalize(scanData.providerName) : "";

    let matched: Provider | undefined;
    if (nifNorm) {
        matched = providers.find((p) => p.taxId && normalize(p.taxId) === nifNorm);
    }
    if (!matched && nameNorm) {
        matched = providers.find((p) => {
            const pn = normalize(p.name);
            return pn === nameNorm || pn.includes(nameNorm) || nameNorm.includes(pn);
        });
    }

    const detectedPct = Number(scanData.retentionPct) || 0;
    const lineRetentionPct = Math.max(0, Math.min(100, detectedPct));
    const retStr = lineRetentionPct ? String(lineRetentionPct) : "0";

    const initialLines: LineItem[] = (scanData.lines || []).map((sl) => {
        const matchedTax = taxes.find((t) => Math.abs(t.rate - sl.taxRatePercent) < 0.5);
        return {
            key:
                typeof crypto !== "undefined" && crypto.randomUUID
                    ? crypto.randomUUID()
                    : Math.random().toString(36).slice(2),
            description: sl.description || "",
            details: sl.details || "",
            quantity: String(sl.quantity || 1),
            unitPriceEuros: (sl.unitPriceEuros || 0).toFixed(2),
            taxId: matchedTax?.id || "",
            taxRate: matchedTax?.rate || sl.taxRatePercent || 0,
            retentionPct: retStr,
        };
    });

    return {
        formState: {
            formProviderId: matched?.id || "",
            formProviderName: scanData.providerName || matched?.name || "",
            formProviderTaxId: scanData.providerTaxId || matched?.taxId || "",
            formProviderAutoCreated: false,
            formInvoiceNumber: scanData.invoiceNumber || "",
            formIssueDate: scanData.issueDate || "",
            formDueDate: scanData.dueDate || "",
            formStatus: "DRAFT" as Status,
            formNotes: scanData.notes || "",
            formLines: initialLines.length > 0 ? initialLines : [emptyLine(retStr)],
        },
    };
}

function emptyLine(retentionPct = "0"): LineItem {
    return {
        key:
            typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2),
        description: "",
        details: "",
        quantity: "1",
        unitPriceEuros: "0.00",
        taxId: "",
        taxRate: 0,
        retentionPct,
    };
}

function computeTotals(lines: LineItem[]) {
    let subtotalCents = 0;
    let taxCents = 0;
    let retentionCents = 0;
    for (const l of lines) {
        const qty = parseFloat(l.quantity) || 0;
        const unitCents = Math.round((parseFloat(l.unitPriceEuros) || 0) * 100);
        const sub = Math.round(qty * unitCents);
        const lineRetPct = parseFloat(l.retentionPct) || 0;
        subtotalCents += sub;
        taxCents += Math.round((sub * l.taxRate) / 100);
        retentionCents += Math.round((sub * lineRetPct) / 100);
    }
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
