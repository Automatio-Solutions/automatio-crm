// ============================================================
// Helper de Supabase Storage para los archivos del escáner.
//
// Bucket: `expense-scans` (público).
// Path: AAAA/MM/uuid_filename.ext  (organizado por año/mes)
//
// Solo se usa desde el server (route handlers / server actions),
// porque firmamos con la SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

import { getSupabase } from "@/lib/supabase";

const BUCKET = "expense-scans";

export interface UploadResult {
    storagePath: string;   // ruta dentro del bucket
    publicUrl: string;     // URL pública (sirve para mostrar/descargar)
    filename: string;      // nombre original (saneado)
    mimeType: string;
    sizeBytes: number;
}

/** Genera un path único: 2026/05/uuid_nombre.ext */
function buildPath(originalFilename: string): { path: string; safeName: string } {
    const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
    // UUID v4 sin dependencias externas
    const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    return { path: `${yyyy}/${mm}/${uuid}_${safeName}`, safeName };
}

/**
 * Sube un archivo al bucket `expense-scans` y devuelve su path + URL pública.
 *
 * Usa el cliente de Supabase con SUPABASE_SERVICE_ROLE_KEY (server-side),
 * por lo que salta cualquier RLS del bucket.
 */
export async function uploadExpenseScan(
    file: File,
    arrayBuffer: ArrayBuffer
): Promise<UploadResult> {
    const supabase = getSupabase();
    const { path, safeName } = buildPath(file.name || "scan");

    const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, Buffer.from(arrayBuffer), {
            cacheControl: "3600",
            upsert: false,
            contentType: file.type || "application/octet-stream",
        });
    if (upErr) {
        throw new Error(`Error al subir el archivo a Supabase Storage: ${upErr.message}`);
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);

    return {
        storagePath: path,
        publicUrl: urlData.publicUrl,
        filename: safeName,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
    };
}

/** Borra un archivo del bucket (si el usuario descarta el escaneo). */
export async function deleteExpenseScan(storagePath: string): Promise<void> {
    const supabase = getSupabase();
    const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
    if (error) {
        throw new Error(`Error al borrar el archivo: ${error.message}`);
    }
}

export const EXPENSE_SCANS_BUCKET = BUCKET;
