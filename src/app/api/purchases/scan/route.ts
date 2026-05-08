// ============================================================
// POST /api/purchases/scan
//
// Recibe un PDF o imagen, lo sube a Supabase Storage (bucket
// `expense-scans`) y usa Anthropic Claude (vision) para extraer
// los datos estructurados de la factura para auto-rellenar el form.
//
// Devuelve los datos extraídos + la URL pública del archivo guardado,
// para que el cliente pueda mostrarlo y adjuntarlo al guardar.
// ============================================================

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { SCAN_SYSTEM_PROMPT, SCAN_USER_PROMPT } from "@/lib/scan/prompt";
import type { ScanResponse, ScannedInvoice } from "@/lib/scan/types";
import { uploadExpenseScan } from "@/lib/storage/expense-scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Hasta 60s para el procesado de IA

// Modelos: alias hacia las versiones más recientes.
const MODEL = "claude-haiku-4-5";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

const ALLOWED_IMAGE_TYPES = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
] as const;
const ALLOWED_DOC_TYPES = ["application/pdf"] as const;
type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export async function POST(request: Request) {
    try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return NextResponse.json(
                { error: "Falta ANTHROPIC_API_KEY en el servidor." },
                { status: 500 }
            );
        }

        const formData = await request.formData();
        const file = formData.get("file");

        if (!(file instanceof File)) {
            return NextResponse.json(
                { error: "No se ha proporcionado ningún archivo." },
                { status: 400 }
            );
        }
        if (file.size === 0) {
            return NextResponse.json(
                { error: "El archivo está vacío." },
                { status: 400 }
            );
        }
        if (file.size > MAX_BYTES) {
            return NextResponse.json(
                {
                    error: `El archivo es demasiado grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máximo: 20 MB.`,
                },
                { status: 400 }
            );
        }

        // Normalizamos image/jpg → image/jpeg para Claude
        let mediaType = file.type;
        if (mediaType === "image/jpg") mediaType = "image/jpeg";

        const isImage = (ALLOWED_IMAGE_TYPES as readonly string[]).includes(mediaType);
        const isPdf = (ALLOWED_DOC_TYPES as readonly string[]).includes(mediaType);
        if (!isImage && !isPdf) {
            return NextResponse.json(
                {
                    error: `Formato no soportado: ${mediaType}. Sube un PDF o imagen (PNG, JPG, WebP).`,
                },
                { status: 400 }
            );
        }

        // 1) Leer bytes (los necesitamos tanto para subir como para Claude).
        const arrayBuffer = await file.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");

        // 2) Subir a Supabase Storage en paralelo al escaneo.
        //    Si falla la subida, devolvemos error (igual que Dani).
        let attachment: ScanResponse["attachment"] = null;
        try {
            const uploaded = await uploadExpenseScan(file, arrayBuffer);
            attachment = {
                storagePath: uploaded.storagePath,
                publicUrl: uploaded.publicUrl,
                filename: uploaded.filename,
                mimeType: uploaded.mimeType,
                sizeBytes: uploaded.sizeBytes,
            };
        } catch (uploadErr) {
            console.error("[scan] upload error:", uploadErr);
            return NextResponse.json(
                {
                    error:
                        uploadErr instanceof Error
                            ? uploadErr.message
                            : "Error al subir el archivo al almacenamiento.",
                },
                { status: 500 }
            );
        }

        // 3) Llamar a Claude Vision con la imagen/PDF.
        const anthropic = new Anthropic({ apiKey });

        const content: Anthropic.MessageParam["content"] = isImage
            ? [
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: mediaType as ImageMediaType,
                        data: base64,
                    },
                },
                { type: "text", text: SCAN_USER_PROMPT },
            ]
            : [
                {
                    type: "document",
                    source: {
                        type: "base64",
                        media_type: "application/pdf",
                        data: base64,
                    },
                },
                { type: "text", text: SCAN_USER_PROMPT },
            ];

        const message = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 2048,
            system: SCAN_SYSTEM_PROMPT,
            messages: [{ role: "user", content }],
        });

        const text = message.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();

        const parsed = extractJson(text);
        if (!parsed) {
            console.error("[scan] No JSON in Claude response:", text);
            return NextResponse.json(
                {
                    error: "No se pudo interpretar la respuesta de la IA. Intenta con otra imagen o PDF más claro.",
                },
                { status: 422 }
            );
        }

        const sanitized = sanitize(parsed);

        const response: ScanResponse = {
            ...sanitized,
            attachment,
        };
        return NextResponse.json(response);
    } catch (err) {
        console.error("[scan] error:", err);
        const msg =
            err instanceof Error
                ? err.message
                : "Error al escanear la factura. Inténtalo de nuevo.";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}

// ─── helpers ─────────────────────────────────────────────────

function extractJson(text: string): unknown | null {
    let s = text.trim();
    // Quitar fences de markdown si los hubiera
    if (s.startsWith("```")) {
        s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    }
    // Si todavía hay texto antes/después, extraer { ... }
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first === -1 || last === -1) return null;
    try {
        return JSON.parse(s.slice(first, last + 1));
    } catch {
        return null;
    }
}

function sanitize(raw: unknown): ScannedInvoice {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

    const linesRaw = Array.isArray(r.lines) ? r.lines : [];
    const lines = linesRaw.map((line) => {
        const l = (line && typeof line === "object" ? line : {}) as Record<string, unknown>;
        return {
            description: String(l.description ?? ""),
            details: String(l.details ?? ""),
            quantity: Number(l.quantity) || 1,
            unitPriceEuros: Number(l.unitPriceEuros) || 0,
            taxRatePercent: Number(l.taxRatePercent) || 0,
        };
    });

    const warningsRaw = Array.isArray(r.warnings) ? r.warnings : [];
    const warnings = warningsRaw
        .map((w) => (typeof w === "string" ? w.trim() : ""))
        .filter((w) => w.length > 0);

    return {
        providerName: String(r.providerName ?? ""),
        providerTaxId: String(r.providerTaxId ?? ""),
        invoiceNumber: String(r.invoiceNumber ?? ""),
        issueDate: String(r.issueDate ?? ""),
        dueDate: String(r.dueDate ?? ""),
        notes: String(r.notes ?? ""),
        confidence: Number(r.confidence) || 0,
        lines,
        warnings,
    };
}
