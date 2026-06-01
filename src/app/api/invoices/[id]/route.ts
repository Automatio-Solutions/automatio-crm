import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit";
import { NextResponse } from "next/server";

// GET /api/invoices/[id]
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const invoice = await prisma.invoice.findUnique({
            where: { id, deletedAt: null },
            include: {
                client: { select: { id: true, name: true, taxId: true, email: true } },
                lines: { include: { tax: true }, orderBy: { position: "asc" } },
            },
        });

        if (!invoice) {
            return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
        }

        return NextResponse.json(invoice);
    } catch (error) {
        return NextResponse.json({ error: "Error al obtener factura" }, { status: 500 });
    }
}

// PUT /api/invoices/[id] — Update invoice (status changes, edit DRAFT)
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const body = await request.json();
        const { status, paidCents: customPaidCents, notes, publicNotes, issueDate, dueDate, lines } = body;

        const invoice = await prisma.invoice.findUnique({ where: { id, deletedAt: null } });
        if (!invoice) {
            return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
        }

        // ── Status-only change ──────────────────────────────
        if (status && !lines) {
            const validTransitions: Record<string, string[]> = {
                ISSUED: ["PAID", "PARTIALLY_PAID", "VOID"],
                PARTIALLY_PAID: ["PAID", "VOID"],
            };

            const allowed = validTransitions[invoice.status] || [];
            if (!allowed.includes(status)) {
                return NextResponse.json(
                    { error: `No se puede cambiar de ${invoice.status} a ${status}` },
                    { status: 400 }
                );
            }

            const updateData: any = { status };

            // When marking as PAID, set paidCents = totalCents
            if (status === "PAID") {
                updateData.paidCents = invoice.totalCents;
            }

            // When marking as PARTIALLY_PAID, allow custom paidCents
            if (status === "PARTIALLY_PAID" && customPaidCents !== undefined) {
                const amount = parseInt(customPaidCents);
                if (isNaN(amount) || amount <= 0 || amount >= invoice.totalCents) {
                    return NextResponse.json(
                        { error: "El importe parcial debe ser mayor que 0 y menor que el total" },
                        { status: 400 }
                    );
                }
                updateData.paidCents = amount;
            }

            // When voiding, keep paidCents as is
            if (status === "VOID") {
                updateData.paidCents = 0;
            }

            const updated = await prisma.invoice.update({
                where: { id },
                data: updateData,
                include: {
                    client: { select: { id: true, name: true, taxId: true, email: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });

            await logActivity(invoice.companyId, null, "invoice", id, "STATUS_CHANGE", {
                from: invoice.status,
                to: status,
            });

            return NextResponse.json(updated);
        }

        // ── Safe-field update (cuando NO es DRAFT) ──────────
        // Solo permitimos cambiar notas, notas públicas y fecha de vencimiento.
        // Importes, líneas, fecha de emisión, número y tipo quedan bloqueados
        // para preservar la integridad fiscal de la factura ya emitida.
        if (invoice.status !== "DRAFT" && !lines) {
            const safeData: Record<string, unknown> = {};
            if (notes !== undefined) safeData.notes = notes;
            if (publicNotes !== undefined) safeData.publicNotes = publicNotes;
            if (dueDate !== undefined) safeData.dueDate = dueDate ? new Date(dueDate) : null;

            if (Object.keys(safeData).length === 0) {
                return NextResponse.json(
                    { error: "No hay campos editables en el body" },
                    { status: 400 }
                );
            }

            const updated = await prisma.invoice.update({
                where: { id },
                data: safeData,
                include: {
                    client: { select: { id: true, name: true, taxId: true, email: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });

            await logActivity(invoice.companyId, null, "invoice", id, "UPDATE", {
                safeEdit: true,
                fields: Object.keys(safeData),
            });

            return NextResponse.json(updated);
        }

        // ── Full update con sustitución de líneas (solo DRAFT) ──
        if (invoice.status !== "DRAFT") {
            return NextResponse.json(
                { error: "Una factura emitida solo se puede modificar parcialmente o rectificar" },
                { status: 400 }
            );
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
        const totalCents = subtotalCents + taxCents;

        const updated = await prisma.$transaction(async (tx) => {
            await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });

            return tx.invoice.update({
                where: { id },
                data: {
                    notes: notes !== undefined ? notes : undefined,
                    publicNotes: publicNotes !== undefined ? publicNotes : undefined,
                    issueDate: issueDate ? new Date(issueDate) : undefined,
                    dueDate: dueDate ? new Date(dueDate) : undefined,
                    subtotalCents,
                    taxCents,
                    totalCents,
                    lines: {
                        create: processedLines,
                    },
                },
                include: {
                    client: { select: { id: true, name: true, taxId: true, email: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });
        });

        await logActivity(invoice.companyId, null, "invoice", id, "UPDATE", {});

        return NextResponse.json(updated);
    } catch (error) {
        console.error("Error updating invoice:", error);
        return NextResponse.json({ error: "Error al actualizar factura" }, { status: 500 });
    }
}

// DELETE /api/invoices/[id] — Soft delete
export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const invoice = await prisma.invoice.findUnique({ where: { id } });
        if (!invoice) {
            return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });
        }
        if (invoice.status !== "DRAFT") {
            return NextResponse.json({ error: "Solo se pueden eliminar facturas en borrador" }, { status: 400 });
        }
        await prisma.invoice.update({
            where: { id },
            data: { deletedAt: new Date() },
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: "Error al eliminar factura" }, { status: 500 });
    }
}
