// ============================================================
// Tipos del escáner de facturas (Claude Vision)
// ============================================================

/**
 * Resultado bruto que devuelve Claude tras analizar el documento.
 * Mantenemos el contrato actual del front (ScannedInvoiceData) para no
 * romper InvoiceScanner.tsx — los campos coinciden con esa interfaz.
 */
export interface ScannedLineItem {
    description: string;
    details: string;
    quantity: number;
    unitPriceEuros: number;   // precio unitario SIN IVA, en euros (no céntimos)
    taxRatePercent: number;   // 21, 10, 4, 0
}

export interface ScannedInvoice {
    providerName: string;
    providerTaxId: string;     // NIF / CIF
    invoiceNumber: string;
    issueDate: string;         // YYYY-MM-DD
    dueDate: string;           // YYYY-MM-DD
    lines: ScannedLineItem[];
    notes: string;
    confidence: number;        // 0-100
    warnings: string[];        // problemas detectados por Claude (totales que no cuadran, retenciones, etc.)
}

/**
 * Respuesta enriquecida del endpoint /api/purchases/scan.
 * Incluye los datos extraídos + la URL del archivo guardado en Supabase Storage,
 * para que el cliente pueda enseñarlo y adjuntarlo al guardar la factura.
 */
export interface ScanResponse extends ScannedInvoice {
    attachment: {
        storagePath: string;
        publicUrl: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
    } | null;
}
