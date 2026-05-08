import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// GET /api/purchases — List purchase invoices
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const status = searchParams.get("status");
        const from = searchParams.get("from");
        const to = searchParams.get("to");

        const dateFilter: any = {};
        if (from) dateFilter.gte = new Date(from);
        if (to) {
            const toDate = new Date(to);
            toDate.setHours(23, 59, 59, 999);
            dateFilter.lte = toDate;
        }

        const purchases = await prisma.purchaseInvoice.findMany({
            where: {
                deletedAt: null,
                ...(status ? { status: status as any } : {}),
                ...(from || to ? { createdAt: dateFilter } : {}),
            },
            include: {
                provider: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        return NextResponse.json(purchases);
    } catch (error) {
        console.error("Error fetching purchase invoices:", error);
        return NextResponse.json({ error: "Error al obtener facturas de proveedor" }, { status: 500 });
    }
}

// POST /api/purchases — Create a new purchase invoice (DRAFT)
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            providerId,
            providerInvoiceNumber,
            notes,
            issueDate,
            dueDate,
            lines,
            attachment,
            retentionPct: retentionPctRaw,
        } = body;

        if (!providerId) {
            return NextResponse.json({ error: "El proveedor es obligatorio" }, { status: 400 });
        }

        const company = await prisma.company.findFirst();
        if (!company) {
            return NextResponse.json({ error: "Empresa no configurada" }, { status: 500 });
        }

        // Calculate line totals — input is now in EUROS, stored as CENTS
        const processedLines = (lines || []).map((line: any, idx: number) => {
            const qty = parseFloat(line.quantity) || 0;

            // Accept both unitPriceEuros (new) and unitPriceCents (legacy)
            let unitCents: number;
            if (line.unitPriceEuros !== undefined) {
                unitCents = Math.round((parseFloat(line.unitPriceEuros) || 0) * 100);
            } else {
                unitCents = parseInt(line.unitPriceCents) || 0;
            }

            const lineSubtotalCents = Math.round(qty * unitCents);
            const taxRate = parseFloat(line.taxRate) || 0;
            const lineTaxCents = Math.round(lineSubtotalCents * taxRate / 100);
            const lineTotalCents = lineSubtotalCents + lineTaxCents;

            return {
                position: idx + 1,
                description: line.description || "",
                details: line.details || null,
                quantity: qty,
                unitPriceCents: unitCents,
                taxId: line.taxId || null,
                lineSubtotalCents,
                lineTaxCents,
                lineTotalCents,
            };
        });

        const subtotalCents = processedLines.reduce((sum: number, l: any) => sum + l.lineSubtotalCents, 0);
        const taxCents = processedLines.reduce((sum: number, l: any) => sum + l.lineTaxCents, 0);

        // Retención (IRPF u otra). Aplicada sobre la base imponible.
        // Aceptamos cualquier % razonable (0-100); típicamente 0, 7 o 15.
        const retentionPctNum = Number(retentionPctRaw);
        const retentionPct = Number.isFinite(retentionPctNum)
            ? Math.max(0, Math.min(100, retentionPctNum))
            : 0;
        const retentionCents = Math.round((subtotalCents * retentionPct) / 100);

        // Total = subtotal + IVA - retention
        const totalCents = subtotalCents + taxCents - retentionCents;

        const purchase = await prisma.purchaseInvoice.create({
            data: {
                companyId: company.id,
                providerId,
                providerInvoiceNumber: providerInvoiceNumber || null,
                status: "DRAFT",
                notes: notes || null,
                issueDate: issueDate ? new Date(issueDate) : null,
                dueDate: dueDate ? new Date(dueDate) : null,
                subtotalCents,
                taxCents,
                retentionPct,
                retentionCents,
                totalCents,
                lines: {
                    create: processedLines,
                },
            },
            include: {
                provider: { select: { id: true, name: true } },
                lines: { include: { tax: true }, orderBy: { position: "asc" } },
            },
        });

        // Si la factura viene del escáner, registramos el archivo como Document
        // asociado a esta PurchaseInvoice. Si falla, lo dejamos pasar (la factura
        // ya está creada y el archivo sigue en Storage; no merece la pena bloquear).
        if (attachment && typeof attachment === "object" && attachment.storagePath) {
            try {
                await prisma.document.create({
                    data: {
                        companyId: company.id,
                        entityType: "PURCHASE_INVOICE",
                        entityId: purchase.id,
                        filename: String(attachment.filename || "scan"),
                        mimeType: String(attachment.mimeType || "application/octet-stream"),
                        sizeBytes: Number(attachment.sizeBytes) || 0,
                        storagePath: String(attachment.storagePath),
                    },
                });
            } catch (docErr) {
                console.error("Error linking scanned attachment to purchase:", docErr);
            }
        }

        return NextResponse.json(purchase, { status: 201 });
    } catch (error) {
        console.error("Error creating purchase invoice:", error);
        return NextResponse.json({ error: "Error al crear factura de proveedor" }, { status: 500 });
    }
}
