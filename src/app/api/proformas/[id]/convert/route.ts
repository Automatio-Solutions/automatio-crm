import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/audit";
import { NextResponse } from "next/server";

// POST /api/proformas/[id]/convert — Convert proforma to real invoice
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        const proforma = await prisma.invoice.findUnique({
            where: { id, deletedAt: null },
            include: {
                lines: { include: { tax: true }, orderBy: { position: "asc" } },
            },
        });

        if (!proforma) {
            return NextResponse.json({ error: "Proforma no encontrada" }, { status: 404 });
        }
        if (proforma.type !== "PROFORMA") {
            return NextResponse.json({ error: "Este documento no es una proforma" }, { status: 400 });
        }

        const company = await prisma.company.findFirst();
        if (!company) {
            return NextResponse.json({ error: "Empresa no configurada" }, { status: 500 });
        }

        // Create a new DRAFT invoice from the proforma data
        const newInvoice = await prisma.invoice.create({
            data: {
                companyId: company.id,
                clientId: proforma.clientId,
                type: "INVOICE",
                status: "DRAFT",
                notes: proforma.notes
                    ? `${proforma.notes}\n[Generada desde proforma ${proforma.number || proforma.id}]`
                    : `[Generada desde proforma ${proforma.number || proforma.id}]`,
                publicNotes: proforma.publicNotes,
                issueDate: null, // Will be set when emitting
                dueDate: null,
                subtotalCents: proforma.subtotalCents,
                taxCents: proforma.taxCents,
                totalCents: proforma.totalCents,
                paidCents: 0,
                lines: {
                    create: proforma.lines.map((line, idx) => ({
                        position: idx + 1,
                        description: line.description,
                        details: line.details,
                        quantity: line.quantity,
                        unitPriceCents: line.unitPriceCents,
                        taxId: line.taxId,
                        lineSubtotalCents: line.lineSubtotalCents,
                        lineTaxCents: line.lineTaxCents,
                        lineTotalCents: line.lineTotalCents,
                    })),
                },
            },
            include: {
                client: { select: { id: true, name: true } },
                lines: { include: { tax: true }, orderBy: { position: "asc" } },
            },
        });

        await logActivity(company.id, null, "invoice", newInvoice.id, "CREATE", {
            convertedFromProforma: proforma.id,
            proformaNumber: proforma.number,
        });

        return NextResponse.json(newInvoice, { status: 201 });
    } catch (error) {
        console.error("Error converting proforma:", error);
        return NextResponse.json({ error: "Error al convertir proforma a factura" }, { status: 500 });
    }
}
