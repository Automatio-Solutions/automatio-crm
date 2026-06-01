import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// GET /api/purchases/[id]
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const purchase = await prisma.purchaseInvoice.findUnique({
            where: { id, deletedAt: null },
            include: {
                provider: { select: { id: true, name: true, taxId: true, email: true } },
                lines: { include: { tax: true }, orderBy: { position: "asc" } },
            },
        });

        if (!purchase) {
            return NextResponse.json({ error: "Factura de proveedor no encontrada" }, { status: 404 });
        }

        return NextResponse.json(purchase);
    } catch (error) {
        return NextResponse.json({ error: "Error al obtener factura de proveedor" }, { status: 500 });
    }
}

// PUT /api/purchases/[id] — Update purchase invoice
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const body = await request.json();
        const { providerId, providerInvoiceNumber, notes, issueDate, dueDate, status, lines } = body;

        // If changing status only (e.g. DRAFT -> BOOKED -> PAID)
        if (status && !lines) {
            const purchase = await prisma.purchaseInvoice.findUnique({ where: { id } });
            if (!purchase) {
                return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
            }

            // Validate transitions
            const validTransitions: Record<string, string[]> = {
                DRAFT: ["BOOKED"],
                BOOKED: ["PAID"],
            };

            const allowed = validTransitions[purchase.status] || [];
            if (!allowed.includes(status)) {
                return NextResponse.json(
                    { error: `No se puede cambiar de ${purchase.status} a ${status}` },
                    { status: 400 }
                );
            }

            const updateData: any = { status };

            // When booking, assign number and issue date
            if (status === "BOOKED") {
                const { getNextNumber } = await import("@/lib/numbering");
                const year = new Date().getFullYear();
                const { number } = await getNextNumber("PURCHASE_INVOICE", year, purchase.companyId);
                updateData.number = number;
                updateData.year = year;
                updateData.issueDate = updateData.issueDate || new Date();

                // Calculate due date from provider payment terms
                const provider = await prisma.provider.findUnique({ where: { id: purchase.providerId } });
                const termsDays = provider?.paymentTermsDays ?? 30;
                const dueDateCalc = new Date();
                dueDateCalc.setDate(dueDateCalc.getDate() + termsDays);
                if (!purchase.dueDate) {
                    updateData.dueDate = dueDateCalc;
                }
            }

            // When paying, set paidCents = totalCents
            if (status === "PAID") {
                updateData.paidCents = purchase.totalCents;
            }

            const updated = await prisma.purchaseInvoice.update({
                where: { id },
                data: updateData,
                include: {
                    provider: { select: { id: true, name: true, taxId: true, email: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });

            return NextResponse.json(updated);
        }

        // ── Edición parcial (sin líneas, solo metadatos) ────
        if (!lines) {
            const current = await prisma.purchaseInvoice.findUnique({ where: { id } });
            if (!current) {
                return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
            }
            const partialData: Record<string, unknown> = {};
            if (notes !== undefined) partialData.notes = notes;
            if (providerInvoiceNumber !== undefined) partialData.providerInvoiceNumber = providerInvoiceNumber;
            if (issueDate !== undefined) partialData.issueDate = issueDate ? new Date(issueDate) : null;
            if (dueDate !== undefined) partialData.dueDate = dueDate ? new Date(dueDate) : null;
            if (providerId) partialData.providerId = providerId;

            if (Object.keys(partialData).length === 0) {
                return NextResponse.json(
                    { error: "No hay campos editables en el body" },
                    { status: 400 }
                );
            }

            const updated = await prisma.purchaseInvoice.update({
                where: { id },
                data: partialData,
                include: {
                    provider: { select: { id: true, name: true, taxId: true, email: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });
            return NextResponse.json(updated);
        }

        // ── Edición completa con sustitución de líneas (cualquier estado) ──
        const purchaseCheck = await prisma.purchaseInvoice.findUnique({ where: { id } });
        if (!purchaseCheck) {
            return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
        }

        const processedLines = (lines || []).map((line: any, idx: number) => {
            const qty = parseFloat(line.quantity) || 0;
            const unitCents = parseInt(line.unitPriceCents) || 0;
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

        // Recalcular retención si el cuerpo la incluye (mismo cálculo que en POST).
        // Si no viene, mantenemos el % previo y recalculamos cents desde el nuevo subtotal.
        const rawPct = body.retentionPct;
        const incomingPct = Number(rawPct);
        const retentionPct = Number.isFinite(incomingPct)
            ? Math.max(0, Math.min(100, incomingPct))
            : Number(purchaseCheck.retentionPct) || 0;
        const rawCents = body.retentionCents;
        const incomingCents = Number(rawCents);
        const retentionCents = Number.isFinite(incomingCents) && incomingCents >= 0
            ? Math.round(incomingCents)
            : Math.round((subtotalCents * retentionPct) / 100);

        const totalCents = subtotalCents + taxCents - retentionCents;

        // Ajustar paidCents y estado si el nuevo total queda por debajo de lo ya pagado
        const dataPatch: Record<string, unknown> = {
            providerId: providerId || undefined,
            providerInvoiceNumber: providerInvoiceNumber !== undefined ? providerInvoiceNumber : undefined,
            notes: notes !== undefined ? notes : undefined,
            issueDate: issueDate ? new Date(issueDate) : undefined,
            dueDate: dueDate ? new Date(dueDate) : undefined,
            subtotalCents,
            taxCents,
            retentionPct,
            retentionCents,
            totalCents,
        };
        if (purchaseCheck.paidCents > totalCents) {
            dataPatch.paidCents = totalCents;
        }

        const purchase = await prisma.$transaction(async (tx) => {
            await tx.purchaseInvoiceLine.deleteMany({ where: { purchaseInvoiceId: id } });

            return tx.purchaseInvoice.update({
                where: { id },
                data: {
                    ...dataPatch,
                    lines: {
                        create: processedLines,
                    },
                },
                include: {
                    provider: { select: { id: true, name: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });
        });

        return NextResponse.json(purchase);
    } catch (error) {
        console.error("Error updating purchase invoice:", error);
        return NextResponse.json({ error: "Error al actualizar factura de proveedor" }, { status: 500 });
    }
}

// DELETE /api/purchases/[id] — Soft delete
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const purchase = await prisma.purchaseInvoice.findUnique({ where: { id } });
        if (!purchase) {
            return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
        }
        if (purchase.status !== "DRAFT") {
            return NextResponse.json({ error: "Solo se pueden eliminar facturas en borrador" }, { status: 400 });
        }
        await prisma.purchaseInvoice.update({
            where: { id },
            data: { deletedAt: new Date() },
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: "Error al eliminar factura de proveedor" }, { status: 500 });
    }
}
