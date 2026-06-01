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

        // ── Edición parcial (sin líneas, solo metadatos) ────
        // Cuando el cliente envía cambios sin tocar las líneas (notas, fechas,
        // cliente, etc.), aplicamos solo lo que viene y dejamos importes intactos.
        if (!lines) {
            const partialData: Record<string, unknown> = {};
            if (notes !== undefined) partialData.notes = notes;
            if (publicNotes !== undefined) partialData.publicNotes = publicNotes;
            if (issueDate !== undefined) partialData.issueDate = issueDate ? new Date(issueDate) : null;
            if (dueDate !== undefined) partialData.dueDate = dueDate ? new Date(dueDate) : null;
            if (body.clientId !== undefined && body.clientId) partialData.clientId = body.clientId;

            if (Object.keys(partialData).length === 0) {
                return NextResponse.json(
                    { error: "No hay campos editables en el body" },
                    { status: 400 }
                );
            }

            const updated = await prisma.invoice.update({
                where: { id },
                data: partialData,
                include: {
                    client: { select: { id: true, name: true, taxId: true, email: true } },
                    lines: { include: { tax: true }, orderBy: { position: "asc" } },
                },
            });

            await logActivity(invoice.companyId, null, "invoice", id, "UPDATE", {
                partial: true,
                fields: Object.keys(partialData),
            });

            return NextResponse.json(updated);
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

        // Si el nuevo total es menor que lo ya cobrado, ajustamos el estado.
        // - Si paid > newTotal → ajustamos paidCents al nuevo total y marcamos PAID.
        // - Si era PAID pero el nuevo total > paid → pasa a PARTIALLY_PAID.
        // - Si no había pago → no tocamos paidCents.
        const dataPatch: Record<string, unknown> = {
            notes: notes !== undefined ? notes : undefined,
            publicNotes: publicNotes !== undefined ? publicNotes : undefined,
            issueDate: issueDate ? new Date(issueDate) : undefined,
            dueDate: dueDate ? new Date(dueDate) : undefined,
            clientId: body.clientId || undefined,
            subtotalCents,
            taxCents,
            totalCents,
        };
        if (invoice.paidCents > totalCents) {
            dataPatch.paidCents = totalCents;
            dataPatch.status = "PAID";
        } else if (invoice.status === "PAID" && invoice.paidCents < totalCents) {
            dataPatch.status = "PARTIALLY_PAID";
        }

        const updated = await prisma.$transaction(async (tx) => {
            await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });

            return tx.invoice.update({
                where: { id },
                data: {
                    ...dataPatch,
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

        await logActivity(invoice.companyId, null, "invoice", id, "UPDATE", {
            wasStatus: invoice.status,
            newStatus: dataPatch.status || invoice.status,
        });

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
